package control

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"umbra/internal/gate"
	"umbra/internal/stealth"
	"umbra/internal/wire"
)

func newTestConsole(t *testing.T) (*Console, *httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "control.json")
	g := gate.New("127.0.0.1", stealth.New(false))
	c, err := New(g, path)
	if err != nil {
		t.Fatal(err)
	}
	c.SkipAuth = true
	srv := httptest.NewServer(c.Handler())
	t.Cleanup(srv.Close)
	return c, srv, dir
}

func doJSON(t *testing.T, srv *httptest.Server, method, path string, body any, hdr map[string]string) *http.Response {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		switch b := body.(type) {
		case string:
			rdr = strings.NewReader(b)
		case []byte:
			rdr = bytes.NewReader(b)
		default:
			raw, err := json.Marshal(b)
			if err != nil {
				t.Fatal(err)
			}
			rdr = bytes.NewReader(raw)
		}
	}
	req, err := http.NewRequest(method, srv.URL+path, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func readBody(t *testing.T, res *http.Response) string {
	t.Helper()
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return string(b)
}

func TestRevokeFailsWhenPersistUnwritable(t *testing.T) {
	c, srv, dir := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("create node %d %s", res.StatusCode, readBody(t, res))
	}
	var created struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if created.ID == "" || created.Token == "" {
		t.Fatal("missing node")
	}

	if err := os.Chmod(dir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0700) })

	res = doJSON(t, srv, "POST", "/v1/nodes/"+created.ID+"/revoke", nil, nil)
	body := readBody(t, res)
	if res.StatusCode == 204 {
		t.Fatalf("revoke must not succeed when persist fails: %s", body)
	}
	if res.StatusCode != 500 {
		t.Fatalf("status %d %s", res.StatusCode, body)
	}

	_ = os.Chmod(dir, 0700)
	raw, err := os.ReadFile(c.Persist)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), created.Token) {
		t.Fatal("plaintext token must not be stored")
	}
	if !strings.Contains(string(raw), gate.TicketHash(created.Token)) {
		t.Fatal("token hash must remain on disk when revoke persist fails")
	}
}

func TestPersistStoresTokenHashNotPlaintext(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	var created struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	raw, err := os.ReadFile(c.Persist)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), created.Token) {
		t.Fatal("plaintext token leaked to control.json")
	}
	if !strings.Contains(string(raw), gate.TicketHash(created.Token)) {
		t.Fatal("token hash missing from control.json")
	}
	res = doJSON(t, srv, "GET", "/v1/nodes/"+created.ID+"/bootstrap", nil, nil)
	if res.StatusCode != http.StatusGone {
		t.Fatalf("bootstrap %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
}

func TestLoadMigratesPlainToken(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "control.json")
	plain := "umbra_boot_legacy"
	doc := persistFile{
		Nodes: []*nodeRec{{ID: "nde_a", Name: "a", Token: plain, Status: "offline", Enabled: true}},
	}
	raw, _ := json.Marshal(doc)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	g := gate.New("127.0.0.1", stealth.New(false))
	c, err := New(g, path)
	if err != nil {
		t.Fatal(err)
	}
	if c.nodes["nde_a"].Token != "" {
		t.Fatal("legacy plaintext must be dropped")
	}
	if c.nodes["nde_a"].TokenHash != gate.TicketHash(plain) {
		t.Fatal("legacy token must be hashed")
	}
	if g.LookupToken(plain) != "nde_a" {
		t.Fatal("migrated hash must still authenticate")
	}
	if c.nodes["nde_a"].TokenUntil.IsZero() {
		t.Fatal("legacy token must receive an expiry")
	}
}

func TestSetupRejectsForeignOrigin(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/setup", map[string]string{"password": "abcdefgh"}, map[string]string{
		"Origin": "http://evil.example",
	})
	body := readBody(t, res)
	if res.StatusCode != 403 {
		t.Fatalf("status %d %s", res.StatusCode, body)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ownerHash != "" {
		t.Fatal("malicious origin must not claim console")
	}
}

func TestSetupRejectsOversizeBody(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	pw := strings.Repeat("x", 300*1024)
	res := doJSON(t, srv, "POST", "/v1/setup", map[string]string{"password": pw}, nil)
	body := readBody(t, res)
	if res.StatusCode != http.StatusRequestEntityTooLarge && res.StatusCode != 400 {
		t.Fatalf("status %d %s", res.StatusCode, body)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ownerHash != "" {
		t.Fatal("oversize setup must not claim console")
	}
}

func TestSetupRejectsForeignOriginOversize(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	pw := strings.Repeat("x", 300*1024)
	res := doJSON(t, srv, "POST", "/v1/setup", map[string]string{"password": pw}, map[string]string{
		"Origin": "http://evil.example",
	})
	body := readBody(t, res)
	if res.StatusCode != 403 && res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d %s", res.StatusCode, body)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ownerHash != "" {
		t.Fatal("malicious oversize setup must not claim console")
	}
}

func TestSetupRejectsTrailingJSON(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		status int
	}{
		{"extra-object", `{"password":"abcdefgh"}{"x":1}`, 400},
		{"trailing-bracket", `{"password":"abcdefgh"}]`, 400},
		{"trailing-brace", `{"password":"abcdefgh"}}`, 400},
		{"trailing-spaces", `{"password":"abcdefgh"}` + strings.Repeat(" ", 300*1024), http.StatusRequestEntityTooLarge},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, srv, _ := newTestConsole(t)
			res := doJSON(t, srv, "POST", "/v1/setup", tc.body, nil)
			body := readBody(t, res)
			if res.StatusCode != tc.status {
				t.Fatalf("status %d want %d %s", res.StatusCode, tc.status, body)
			}
			c.mu.Lock()
			defer c.mu.Unlock()
			if c.ownerHash != "" {
				t.Fatal("trailing junk must not complete setup")
			}
		})
	}
}

func TestPortConflictOnEnableAndLegacyPut(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	var n1 struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&n1); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n2"}, nil)
	var n2 struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&n2); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	port := 41280
	mk := func(nodeID, name string) map[string]any {
		return map[string]any{
			"nodeId": nodeID, "name": name, "proto": "tcp", "mode": "public",
			"entryPort": port, "localHost": "127.0.0.1", "localPort": 22,
		}
	}
	res = doJSON(t, srv, "POST", "/v1/mappings", mk(n1.ID, "a"), nil)
	if res.StatusCode != 200 {
		t.Fatalf("first mapping %d %s", res.StatusCode, readBody(t, res))
	}
	var m1 struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&m1); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	res = doJSON(t, srv, "POST", "/v1/mappings", mk(n2.ID, "b"), nil)
	body := readBody(t, res)
	if res.StatusCode != 400 {
		t.Fatalf("second create should conflict, got %d %s", res.StatusCode, body)
	}

	res = doJSON(t, srv, "POST", "/v1/mappings", map[string]any{
		"nodeId": n2.ID, "name": "b", "proto": "tcp", "mode": "public",
		"entryPort": port + 1, "localHost": "127.0.0.1", "localPort": 22,
	}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("other port %d %s", res.StatusCode, readBody(t, res))
	}
	var m2 struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&m2); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	res = doJSON(t, srv, "POST", "/v1/mappings/"+m2.ID+"/enabled", map[string]any{"enabled": false}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("disable %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	res = doJSON(t, srv, "POST", "/v1/mappings/"+m2.ID+"/enabled", map[string]any{
		"enabled": true,
		"note":    "ignored",
	}, nil)
	// enabling m2 still uses port+1, should work
	if res.StatusCode != 200 {
		t.Fatalf("re-enable own port %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	res = doJSON(t, srv, "POST", "/v1/mappings/"+m2.ID+"/enabled", map[string]any{"enabled": false}, nil)
	readBody(t, res)

	// change m2 to the taken port via legacy PUT while enabling
	p := port
	res = doJSON(t, srv, "PUT", "/v1/nodes/"+n2.ID+"/mappings", []wire.Mapping{{
		ID: m2.ID, Name: "b", Proto: "tcp", Mode: "public",
		EntryPort: &p, LocalHost: "127.0.0.1", LocalPort: 22, Enabled: true,
	}}, nil)
	body = readBody(t, res)
	if res.StatusCode != 400 {
		t.Fatalf("legacy PUT should reject port conflict, got %d %s", res.StatusCode, body)
	}

	res = doJSON(t, srv, "PUT", "/v1/nodes/"+n2.ID+"/mappings", []wire.Mapping{{
		ID: m2.ID, Name: "b", Proto: "tcp", Mode: "public",
		EntryPort: &p, LocalHost: "127.0.0.1", LocalPort: 22, Enabled: false,
	}}, nil)
	if res.StatusCode != 204 {
		t.Fatalf("disabled PUT on taken port should persist, got %d %s", res.StatusCode, readBody(t, res))
	}

	res = doJSON(t, srv, "POST", "/v1/mappings/"+m2.ID+"/enabled", map[string]any{"enabled": true}, nil)
	body = readBody(t, res)
	if res.StatusCode != 400 {
		t.Fatalf("enable should reject port conflict, got %d %s", res.StatusCode, body)
	}
}

func TestLoadDisablesConflictingPorts(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "control.json")
	p := 41300
	doc := persistFile{
		Nodes: []*nodeRec{{ID: "nde_a", Name: "a", Status: "offline", Enabled: true}},
		Maps: []*mapRec{
			{Spec: wire.Mapping{ID: "m1", Name: "one", Proto: "tcp", Mode: "public", EntryPort: &p, LocalHost: "127.0.0.1", LocalPort: 22, Enabled: true}, NodeID: "nde_a"},
			{Spec: wire.Mapping{ID: "m2", Name: "two", Proto: "tcp", Mode: "public", EntryPort: &p, LocalHost: "127.0.0.1", LocalPort: 23, Enabled: true}, NodeID: "nde_a"},
		},
	}
	raw, _ := json.Marshal(doc)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	g := gate.New("127.0.0.1", stealth.New(false))
	c, err := New(g, path)
	if err != nil {
		t.Fatal(err)
	}
	if !c.maps["m1"].Spec.Enabled {
		t.Fatal("first mapping should stay enabled")
	}
	if c.maps["m2"].Spec.Enabled {
		t.Fatal("conflicting mapping must be disabled on restore")
	}
}

func cookieClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Jar: jar}
}

func TestOwnerSessionLogoutRevokesCopy(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	cli := cookieClient(t)
	setupReq, _ := http.NewRequest("POST", srv.URL+"/v1/setup", strings.NewReader(`{"password":"abcdefgh"}`))
	setupReq.Header.Set("content-type", "application/json")
	res, err := cli.Do(setupReq)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("setup %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	res, err = cli.Get(srv.URL + "/v1/nodes")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("authed %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	u := res.Request.URL
	stolen, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	stolen.SetCookies(u, cli.Jar.Cookies(u))
	thief := &http.Client{Jar: stolen}
	res, err = thief.Get(srv.URL + "/v1/nodes")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("copied cookie should work before logout: %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	req, _ := http.NewRequest("POST", srv.URL+"/v1/logout", nil)
	res, err = cli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, res)

	res, err = thief.Get(srv.URL + "/v1/nodes")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("copied cookie after logout %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
}

func TestPasswordChangeRevokesAllSessions(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	a := cookieClient(t)
	bcli := cookieClient(t)
	req, _ := http.NewRequest("POST", srv.URL+"/v1/setup", strings.NewReader(`{"password":"abcdefgh"}`))
	req.Header.Set("content-type", "application/json")
	res, err := a.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, res)
	req, _ = http.NewRequest("POST", srv.URL+"/v1/login", strings.NewReader(`{"password":"abcdefgh"}`))
	req.Header.Set("content-type", "application/json")
	res, err = bcli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("login %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	req, _ = http.NewRequest("POST", srv.URL+"/v1/password", strings.NewReader(`{"current":"abcdefgh","new":"newpassword"}`))
	req.Header.Set("content-type", "application/json")
	res, err = a.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("password %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	res, err = bcli.Get(srv.URL + "/v1/nodes")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("other session after password change %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
	res, err = a.Get(srv.URL + "/v1/nodes")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("current session after password change %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
}

func TestLoginRateLimitCountsFailuresOnly(t *testing.T) {
	c, _, _ := newTestConsole(t)
	c.SkipAuth = false
	if err := c.setup("abcdefgh"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 12; i++ {
		if err := c.login("abcdefgh", "1.2.3.4"); err != nil {
			t.Fatalf("good password %d: %v", i, err)
		}
	}
	for i := 0; i < 8; i++ {
		err := c.login("wrongpass", "1.2.3.4")
		if err == nil || !strings.Contains(err.Error(), "口令不对") {
			t.Fatalf("wrong password %d: %v", i, err)
		}
	}
	err := c.login("abcdefgh", "1.2.3.4")
	if err == nil || !strings.Contains(err.Error(), "试得太勤") {
		t.Fatalf("want lockout after 8 failures, got %v", err)
	}
	err = c.login("wrongpass", "9.9.9.9")
	if err == nil || !strings.Contains(err.Error(), "口令不对") {
		t.Fatalf("other IP should still try, got %v", err)
	}
}

func TestPersistEnvelopeChecksumAndPrev(t *testing.T) {
	c, srv, dir := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("create %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
	raw, err := os.ReadFile(c.Persist)
	if err != nil {
		t.Fatal(err)
	}
	var box persistBox
	if err := json.Unmarshal(raw, &box); err != nil {
		t.Fatal(err)
	}
	if box.Schema != persistSchema || box.Checksum == "" || len(box.Payload) == 0 {
		t.Fatalf("envelope %+v", box)
	}
	if persistChecksum(compactJSON(box.Payload)) != box.Checksum {
		t.Fatal("stored checksum mismatch")
	}

	res = doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n2"}, nil)
	readBody(t, res)
	prev, err := os.ReadFile(c.Persist + ".prev")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(prev), `"n1"`) && !strings.Contains(string(prev), "n1") {
		// payload is compact JSON; node name is inside
		var prevBox persistBox
		if err := json.Unmarshal(prev, &prevBox); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(prevBox.Payload), "n1") {
			t.Fatalf("prev should be previous generation: %s", prevBox.Payload)
		}
	}

	bad := append([]byte{}, raw...)
	if i := strings.Index(string(bad), box.Checksum); i >= 0 {
		bad[i] = '0'
		if bad[i] == raw[i] {
			bad[i] = '1'
		}
	} else {
		t.Fatal("checksum not in file")
	}
	if err := os.WriteFile(c.Persist, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(c.Persist + ".prev")
	g := gate.New("127.0.0.1", stealth.New(false))
	if _, err := New(g, c.Persist); err == nil {
		t.Fatal("tampered checksum without prev must fail closed")
	}

	if err := os.WriteFile(c.Persist+".prev", raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(c.Persist, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	g = gate.New("127.0.0.1", stealth.New(false))
	c2, err := New(g, c.Persist)
	if err != nil {
		t.Fatal(err)
	}
	if len(c2.nodes) == 0 {
		t.Fatal("corrupt current should restore previous generation")
	}

	if err := os.WriteFile(c.Persist, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(c.Persist+".prev", []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	g = gate.New("127.0.0.1", stealth.New(false))
	if _, err := New(g, c.Persist); err == nil {
		t.Fatal("corrupt current and prev must fail closed")
	}

	unknown := persistBox{Schema: persistSchema + 9, Checksum: persistChecksum([]byte(`{}`)), Payload: []byte(`{}`)}
	raw, _ = json.Marshal(unknown)
	if err := os.WriteFile(filepath.Join(dir, "other.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	g = gate.New("127.0.0.1", stealth.New(false))
	if _, err := New(g, filepath.Join(dir, "other.json")); err == nil {
		t.Fatal("unknown schema must fail closed")
	}
}

func TestNodeTokenExpiryForced(t *testing.T) {
	old := gate.TokenTTL
	gate.TokenTTL = 80 * time.Millisecond
	t.Cleanup(func() { gate.TokenTTL = old })

	c, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	var created struct {
		ID        string `json:"id"`
		Token     string `json:"token"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if created.Token == "" || created.ExpiresAt == "" {
		t.Fatal("issue must return expiry")
	}
	if c.Gate.LookupToken(created.Token) != created.ID {
		t.Fatal("token must work before expiry")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if c.Gate.LookupToken(created.Token) == "" {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatal("expired token must stop authenticating")
}

func TestRotateKeepsGraceThenNewExpiry(t *testing.T) {
	oldTTL, oldGrace := gate.TokenTTL, gate.TokenGrace
	gate.TokenTTL = time.Hour
	gate.TokenGrace = 80 * time.Millisecond
	t.Cleanup(func() { gate.TokenTTL = oldTTL; gate.TokenGrace = oldGrace })

	c, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	var created struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = doJSON(t, srv, "POST", "/v1/nodes/"+created.ID+"/rotate", nil, nil)
	var rotated struct {
		Token     string `json:"token"`
		GraceSec  int    `json:"graceSec"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := json.NewDecoder(res.Body).Decode(&rotated); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if rotated.Token == "" || rotated.ExpiresAt == "" {
		t.Fatal("rotate must return token and expiry")
	}
	if c.Gate.LookupToken(created.Token) != created.ID || c.Gate.LookupToken(rotated.Token) != created.ID {
		t.Fatal("both hashes must work during grace")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if c.Gate.LookupToken(created.Token) == "" {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if c.Gate.LookupToken(created.Token) != "" {
		t.Fatal("old token must expire after grace")
	}
	if c.Gate.LookupToken(rotated.Token) != created.ID {
		t.Fatal("new token must remain after grace")
	}
}

func TestRotateExpiredTokenHasNoGrace(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	var created struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	c.mu.Lock()
	rec := c.nodes[created.ID]
	past := time.Now().Add(-time.Second)
	rec.TokenUntil = past
	h := rec.TokenHash
	c.mu.Unlock()
	c.Gate.SetTokenHashUntil(h, created.ID, past)
	if c.Gate.LookupToken(created.Token) != "" {
		t.Fatal("expired token should not authenticate")
	}
	res = doJSON(t, srv, "POST", "/v1/nodes/"+created.ID+"/rotate", nil, nil)
	var rotated struct {
		Token    string `json:"token"`
		GraceSec int    `json:"graceSec"`
	}
	if err := json.NewDecoder(res.Body).Decode(&rotated); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("rotate %d", res.StatusCode)
	}
	if rotated.GraceSec != 0 {
		t.Fatalf("expired rotate graceSec=%d want 0", rotated.GraceSec)
	}
	if c.Gate.LookupToken(created.Token) != "" {
		t.Fatal("rotate must not revive expired token")
	}
	if c.Gate.LookupToken(rotated.Token) != created.ID {
		t.Fatal("new token must work")
	}
}

func TestNodeTokenNeverExpire(t *testing.T) {
	oldTTL, oldGrace := gate.TokenTTL, gate.TokenGrace
	gate.TokenTTL = 80 * time.Millisecond
	gate.TokenGrace = 80 * time.Millisecond
	t.Cleanup(func() { gate.TokenTTL = oldTTL; gate.TokenGrace = oldGrace })

	c, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]any{"name": "keep", "neverExpire": true}, nil)
	var created struct {
		ID          string `json:"id"`
		Token       string `json:"token"`
		ExpiresAt   string `json:"expiresAt"`
		NeverExpire bool   `json:"neverExpire"`
	}
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 || created.Token == "" || created.ExpiresAt != "" || !created.NeverExpire {
		t.Fatalf("create never-expire: status=%d expires=%q never=%v", res.StatusCode, created.ExpiresAt, created.NeverExpire)
	}
	c.mu.Lock()
	rec := c.nodes[created.ID]
	if rec == nil || !rec.TokenNoExpiry || !rec.TokenUntil.IsZero() {
		c.mu.Unlock()
		t.Fatal("create must persist never-expire")
	}
	c.mu.Unlock()
	time.Sleep(150 * time.Millisecond)
	if c.Gate.LookupToken(created.Token) != created.ID {
		t.Fatal("never-expire token must survive default TTL")
	}

	g2 := gate.New("127.0.0.1", stealth.New(false))
	c2, err := New(g2, c.Persist)
	if err != nil {
		t.Fatal(err)
	}
	c2.mu.Lock()
	rec2 := c2.nodes[created.ID]
	if rec2 == nil || !rec2.TokenNoExpiry || !rec2.TokenUntil.IsZero() {
		c2.mu.Unlock()
		t.Fatal("reload must keep never-expire and not migrate a TTL")
	}
	c2.mu.Unlock()
	if g2.LookupToken(created.Token) != created.ID {
		t.Fatal("reloaded never-expire token must authenticate")
	}

	res = doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "ttl"}, nil)
	var timed struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&timed); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = doJSON(t, srv, "PATCH", "/v1/nodes/"+timed.ID, map[string]any{"neverExpire": true}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("patch never-expire %d %s", res.StatusCode, readBody(t, res))
	}
	var patched map[string]any
	if err := json.NewDecoder(res.Body).Decode(&patched); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if patched["tokenNoExpiry"] != true {
		t.Fatalf("patch view %v", patched)
	}
	if exp, _ := patched["tokenExpiresAt"].(string); exp != "" {
		t.Fatalf("patched expiry %q", exp)
	}
	time.Sleep(150 * time.Millisecond)
	if c.Gate.LookupToken(timed.Token) != timed.ID {
		t.Fatal("current hash must stay valid after turning off expiry")
	}

	res = doJSON(t, srv, "POST", "/v1/nodes/"+created.ID+"/rotate", nil, nil)
	var rotated struct {
		Token       string `json:"token"`
		GraceSec    int    `json:"graceSec"`
		ExpiresAt   string `json:"expiresAt"`
		NeverExpire bool   `json:"neverExpire"`
	}
	if err := json.NewDecoder(res.Body).Decode(&rotated); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if rotated.Token == "" || rotated.ExpiresAt != "" || !rotated.NeverExpire {
		t.Fatalf("rotate inherit: expires=%q never=%v", rotated.ExpiresAt, rotated.NeverExpire)
	}
	if c.Gate.LookupToken(created.Token) != created.ID || c.Gate.LookupToken(rotated.Token) != created.ID {
		t.Fatal("rotate must keep grace for a never-expire old token")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if c.Gate.LookupToken(created.Token) == "" {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if c.Gate.LookupToken(created.Token) != "" {
		t.Fatal("old never-expire token must die after grace")
	}
	time.Sleep(150 * time.Millisecond)
	if c.Gate.LookupToken(rotated.Token) != created.ID {
		t.Fatal("rotated never-expire token must survive default TTL")
	}
}

func TestPutTokenReplaceDropsOldHash(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "PUT", "/v1/tokens/token_old", map[string]string{"node_id": "nde_put"}, nil)
	if res.StatusCode != 204 {
		t.Fatalf("put old %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
	if c.Gate.LookupToken("token_old") != "nde_put" {
		t.Fatal("old token should enroll after first put")
	}
	res = doJSON(t, srv, "PUT", "/v1/tokens/token_new", map[string]string{"node_id": "nde_put"}, nil)
	if res.StatusCode != 204 {
		t.Fatalf("put new %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
	if c.Gate.LookupToken("token_old") != "" {
		t.Fatal("old token must not enroll after replace")
	}
	if c.Gate.LookupToken("token_new") != "nde_put" {
		t.Fatal("new token must enroll after replace")
	}
}

func TestPutTokenPersistFailDoesNotPublish(t *testing.T) {
	c, srv, dir := newTestConsole(t)
	plain := "umbra_boot_putfail"
	if err := os.Chmod(dir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0700) })
	res := doJSON(t, srv, "PUT", "/v1/tokens/"+plain, map[string]string{"node_id": "nde_put"}, nil)
	body := readBody(t, res)
	if res.StatusCode != 500 {
		t.Fatalf("put token persist fail %d %s", res.StatusCode, body)
	}
	if c.Gate.LookupToken(plain) != "" {
		t.Fatal("failed persist must not publish token to gate")
	}
}

func TestPrevRestoreDoesNotReviveRevokedToken(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	var created struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = doJSON(t, srv, "POST", "/v1/nodes/"+created.ID+"/revoke", nil, nil)
	if res.StatusCode != 204 {
		t.Fatalf("revoke %d %s", res.StatusCode, readBody(t, res))
	}
	if c.Gate.LookupToken(created.Token) != "" {
		t.Fatal("revoked token still live")
	}
	if err := os.WriteFile(c.Persist, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	g := gate.New("127.0.0.1", stealth.New(false))
	c2, err := New(g, c.Persist)
	if err != nil {
		t.Fatal(err)
	}
	if g.LookupToken(created.Token) != "" {
		t.Fatal("prev restore must not revive revoked token")
	}
	if rec := c2.nodes[created.ID]; rec != nil && rec.Status != "revoked" && rec.TokenHash != "" {
		t.Fatal("prev restore must not reinstall credential")
	}
}

func TestPrevRestoreDoesNotReviveOwnerSession(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	cli := cookieClient(t)
	req, _ := http.NewRequest("POST", srv.URL+"/v1/setup", strings.NewReader(`{"password":"abcdefgh"}`))
	req.Header.Set("content-type", "application/json")
	res, err := cli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("setup %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
	req, _ = http.NewRequest("POST", srv.URL+"/v1/logout-all", nil)
	res, err = cli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, res)
	if err := os.WriteFile(c.Persist, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	g := gate.New("127.0.0.1", stealth.New(false))
	c2, err := New(g, c.Persist)
	if err != nil {
		t.Fatal(err)
	}
	if len(c2.sessions) != 0 {
		t.Fatal("prev restore must not revive owner sessions")
	}
}

func TestOwnerSessionExpires(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	old := sessionTTL
	sessionTTL = 40 * time.Millisecond
	t.Cleanup(func() { sessionTTL = old })
	cli := cookieClient(t)
	req, _ := http.NewRequest("POST", srv.URL+"/v1/setup", strings.NewReader(`{"password":"abcdefgh"}`))
	req.Header.Set("content-type", "application/json")
	res, err := cli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, res)
	time.Sleep(80 * time.Millisecond)
	res, err = cli.Get(srv.URL + "/v1/nodes")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired session %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
}

func TestHealthAndMappingsExposeUDPAdmit(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "GET", "/health", nil, nil)
	var health map[string]any
	if err := json.NewDecoder(res.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 && res.StatusCode != 503 {
		t.Fatalf("health %d %v", res.StatusCode, health)
	}
	for _, k := range []string{
		"udpActive", "udpDropMaxConns", "udpDropPerIP", "udpDropRate", "active",
		"udpMaxFlowsPerIP", "udpNewFlowsPerSec", "udpNewFlowsPerMap",
		"udpIngressPackets", "udpToNodePackets", "udpFromNodePackets", "udpToClientPackets",
		"udpDropAcl", "udpDropSpa", "udpDropNoPath", "udpDropUnknownFlow", "udpDropClientWrite",
		"udpUplaneRxPackets", "udpUplaneReadErrors", "udpUplaneDecodeErrors",
		"udpUplaneTxPackets", "udpUplaneNotReady", "udpUplaneWriteErrors",
	} {
		if _, ok := health[k]; !ok {
			t.Fatalf("health missing %s in %v", k, health)
		}
	}

	res = doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("node %d %s", res.StatusCode, readBody(t, res))
	}
	var n struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&n); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = doJSON(t, srv, "POST", "/v1/mappings", map[string]any{
		"nodeId": n.ID, "name": "u", "proto": "udp", "mode": "public",
		"entryPort": 48102, "localHost": "127.0.0.1", "localPort": 9,
	}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("mapping %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	res = doJSON(t, srv, "GET", "/v1/mappings", nil, nil)
	if res.StatusCode != 200 {
		t.Fatalf("list %d %s", res.StatusCode, readBody(t, res))
	}
	var maps []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&maps); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if len(maps) == 0 {
		t.Fatal("no mappings")
	}
	m := maps[0]
	for _, k := range []string{
		"udpActive", "udpDropMaxConns", "udpDropPerIP", "udpDropRate", "activeConns", "reach",
		"idleTimeoutSec", "spaTtlSec", "udpIdleTimeoutSec", "grants", "tcpDropMaxConns",
		"udpIngressPackets", "udpToNodePackets", "udpFromNodePackets", "udpToClientPackets",
		"udpDropAcl", "udpDropSpa", "udpDropTrafficLimit", "udpDropNoPath",
		"udpDropEncode", "udpDropUplaneWrite", "udpDropTunnelWrite", "udpDropUnknownFlow", "udpDropClientWrite",
	} {
		if _, ok := m[k]; !ok {
			t.Fatalf("mapping missing %s in %v", k, m)
		}
	}
}

func TestCreateMappingDefaults(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("node %d %s", res.StatusCode, readBody(t, res))
	}
	var n struct {
		ID         string `json:"id"`
		InstallCmd string `json:"installCmd"`
	}
	if err := json.NewDecoder(res.Body).Decode(&n); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if !strings.Contains(n.InstallCmd, "umbra-node --server") {
		t.Fatalf("installCmd %q", n.InstallCmd)
	}
	res = doJSON(t, srv, "POST", "/v1/mappings", map[string]any{
		"nodeId": n.ID, "name": "ssh", "proto": "tcp", "mode": "public",
		"entryPort": 2222, "localHost": "127.0.0.1", "localPort": 22,
	}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("mapping %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
	res = doJSON(t, srv, "GET", "/v1/mappings", nil, nil)
	if res.StatusCode != 200 {
		t.Fatalf("list %d %s", res.StatusCode, readBody(t, res))
	}
	var maps []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&maps); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if len(maps) == 0 {
		t.Fatal("no mappings")
	}
	m := maps[0]
	if int(m["maxConns"].(float64)) != 1024 {
		t.Fatalf("maxConns default %v", m["maxConns"])
	}
	if int(m["idleTimeoutSec"].(float64)) != 0 {
		t.Fatalf("idleTimeoutSec default %v", m["idleTimeoutSec"])
	}
	if int(m["spaTtlSec"].(float64)) != 60 {
		t.Fatalf("spaTtlSec default %v", m["spaTtlSec"])
	}
	if int(m["udpIdleTimeoutSec"].(float64)) != 60 {
		t.Fatalf("udpIdleTimeoutSec default %v", m["udpIdleTimeoutSec"])
	}
}

func TestSPAKnockBindsRequestIPAndMappingTTL(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("node %d %s", res.StatusCode, readBody(t, res))
	}
	var n struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&n); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = doJSON(t, srv, "POST", "/v1/mappings", map[string]any{
		"nodeId": n.ID, "name": "ssh", "proto": "tcp", "mode": "spa",
		"entryPort": 40222, "localHost": "127.0.0.1", "localPort": 22,
		"spaTtlSec": 15,
	}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("mapping %d %s", res.StatusCode, readBody(t, res))
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = doJSON(t, srv, "POST", "/v1/mappings/"+created.ID+"/knock", map[string]any{"ip": "203.0.113.8"}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("knock %d %s", res.StatusCode, readBody(t, res))
	}
	var kn map[string]any
	if err := json.NewDecoder(res.Body).Decode(&kn); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if kn["ip"] != "203.0.113.8" {
		t.Fatalf("knock ip %v", kn["ip"])
	}
	if int(kn["ttlSec"].(float64)) != 15 {
		t.Fatalf("knock ttl %v", kn["ttlSec"])
	}
	res = doJSON(t, srv, "GET", "/v1/mappings", nil, nil)
	var maps []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&maps); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if len(maps) == 0 || maps[0]["grantIP"] != "203.0.113.8" {
		t.Fatalf("grantIP %v", maps)
	}
}

func TestOverviewAlertsAndTickets(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "GET", "/v1/overview", nil, nil)
	if res.StatusCode != 200 {
		t.Fatalf("overview %d %s", res.StatusCode, readBody(t, res))
	}
	var ov map[string]any
	if err := json.NewDecoder(res.Body).Decode(&ov); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if _, ok := ov["alerts"]; !ok {
		t.Fatalf("overview missing alerts %v", ov)
	}
	res = doJSON(t, srv, "GET", "/v1/tickets", nil, nil)
	if res.StatusCode != 200 {
		t.Fatalf("tickets %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
}

func TestNodeAndMappingUpdateDelete(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1", "comment": "old", "os": "linux", "arch": "amd64"}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("create node %d %s", res.StatusCode, readBody(t, res))
	}
	var n struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&n); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	res = doJSON(t, srv, "PATCH", "/v1/nodes/"+n.ID, map[string]string{"name": "nas", "comment": "书房"}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("patch node %d %s", res.StatusCode, readBody(t, res))
	}
	var patched map[string]any
	if err := json.NewDecoder(res.Body).Decode(&patched); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if patched["name"] != "nas" || patched["comment"] != "书房" {
		t.Fatalf("patch node body %v", patched)
	}

	res = doJSON(t, srv, "POST", "/v1/mappings", map[string]any{
		"nodeId": n.ID, "name": "ssh", "proto": "tcp", "mode": "spa",
		"entryPort": 40222, "localHost": "127.0.0.1", "localPort": 22,
	}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("create mapping %d %s", res.StatusCode, readBody(t, res))
	}
	var m struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&m); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	res = doJSON(t, srv, "PATCH", "/v1/mappings/"+m.ID, map[string]any{
		"name": "ssh-home", "localPort": 2222, "maxConns": 8, "allowCidrs": "10.0.0.0/8",
	}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("patch mapping %d %s", res.StatusCode, readBody(t, res))
	}
	var mv map[string]any
	if err := json.NewDecoder(res.Body).Decode(&mv); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if mv["name"] != "ssh-home" || mv["localPort"] != float64(2222) {
		t.Fatalf("patch mapping body %v", mv)
	}
	if mv["allowCidrs"] != "10.0.0.0/8" {
		t.Fatalf("allowCidrs %v", mv["allowCidrs"])
	}

	res = doJSON(t, srv, "PATCH", "/v1/mappings/"+m.ID, map[string]any{"mode": "visitor"}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("visitor patch %d %s", res.StatusCode, readBody(t, res))
	}
	if err := json.NewDecoder(res.Body).Decode(&mv); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if mv["mode"] != "visitor" || mv["entryPort"] != nil {
		t.Fatalf("visitor should drop entry port %v", mv)
	}

	res = doJSON(t, srv, "POST", "/v1/mappings/"+m.ID+"/visitor", map[string]any{"label": "laptop"}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("issue visitor %d %s", res.StatusCode, readBody(t, res))
	}
	var issued map[string]any
	if err := json.NewDecoder(res.Body).Decode(&issued); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	cmd, _ := issued["visitCmd"].(string)
	if !strings.Contains(cmd, "--tls-ca /etc/umbra/ca.crt") {
		t.Fatalf("visitor command must reference the CA path on the visitor machine: %q", cmd)
	}

	res = doJSON(t, srv, "POST", "/v1/nodes/"+n.ID+"/delete", nil, nil)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("delete with mapping should 409, got %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	res = doJSON(t, srv, "POST", "/v1/nodes/"+n.ID+"/delete", map[string]any{"force": true}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("force delete %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	c.mu.Lock()
	if _, ok := c.nodes[n.ID]; ok {
		c.mu.Unlock()
		t.Fatal("node still present")
	}
	if _, ok := c.maps[m.ID]; ok {
		c.mu.Unlock()
		t.Fatal("mapping still present")
	}
	c.mu.Unlock()

	res = doJSON(t, srv, "GET", "/v1/nodes", nil, nil)
	var nodes []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&nodes); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if len(nodes) != 0 {
		t.Fatalf("nodes after delete %v", nodes)
	}
}

func TestPatchMappingPortConflict(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	var n struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&n); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	port := 41990
	res = doJSON(t, srv, "POST", "/v1/mappings", map[string]any{
		"nodeId": n.ID, "name": "a", "proto": "tcp", "mode": "public",
		"entryPort": port, "localHost": "127.0.0.1", "localPort": 22,
	}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("a %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
	res = doJSON(t, srv, "POST", "/v1/mappings", map[string]any{
		"nodeId": n.ID, "name": "b", "proto": "tcp", "mode": "public",
		"entryPort": port + 1, "localHost": "127.0.0.1", "localPort": 23,
	}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("b %d %s", res.StatusCode, readBody(t, res))
	}
	var b struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&b); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = doJSON(t, srv, "PATCH", "/v1/mappings/"+b.ID, map[string]any{"entryPort": port}, nil)
	if res.StatusCode != 400 {
		t.Fatalf("conflict want 400 got %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
}

func TestEventsStream(t *testing.T) {
	_, srv, _ := newTestConsole(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", srv.URL+"/v1/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("events %d %s", res.StatusCode, readBody(t, res))
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("content-type %s", ct)
	}
	buf := make([]byte, 8192)
	n, err := res.Body.Read(buf)
	if n == 0 && err != nil {
		t.Fatalf("read events: %v", err)
	}
	body := string(buf[:n])
	if !strings.Contains(body, "event: live") || !strings.Contains(body, `"overview"`) {
		t.Fatalf("first event %q", body)
	}
	if !strings.Contains(body, `"mappings"`) || !strings.Contains(body, `"nodes"`) {
		t.Fatalf("payload missing collections %q", body)
	}
}

func TestAbsorbStatsKeepsPersistedAcrossReset(t *testing.T) {
	m := &mapRec{BytesIn: 1000, BytesOut: 200}
	in, out := m.absorbStats(0, 0)
	if in != 1000 || out != 200 {
		t.Fatalf("first %d/%d", in, out)
	}
	in, out = m.absorbStats(50, 10)
	if in != 1050 || out != 210 {
		t.Fatalf("delta %d/%d", in, out)
	}
	in, out = m.absorbStats(0, 0)
	if in != 1050 || out != 210 {
		t.Fatalf("reset %d/%d", in, out)
	}
	in, out = m.absorbStats(5, 1)
	if in != 1055 || out != 211 {
		t.Fatalf("after reset %d/%d", in, out)
	}
}

func TestDeleteNodePersistFail(t *testing.T) {
	c, srv, dir := newTestConsole(t)
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	var n struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&n); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if err := os.Chmod(dir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0700) })
	res = doJSON(t, srv, "POST", "/v1/nodes/"+n.ID+"/delete", nil, nil)
	body := readBody(t, res)
	if res.StatusCode != 500 {
		t.Fatalf("delete persist fail %d %s", res.StatusCode, body)
	}
	_ = os.Chmod(dir, 0700)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.nodes[n.ID] == nil {
		t.Fatal("node vanished after failed delete")
	}
}
