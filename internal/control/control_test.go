package control

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	if !strings.Contains(string(raw), created.Token) {
		t.Fatal("token must remain on disk when revoke persist fails")
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
	var n1 struct{ ID string `json:"id"` }
	if err := json.NewDecoder(res.Body).Decode(&n1); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	res = doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n2"}, nil)
	var n2 struct{ ID string `json:"id"` }
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
	var m1 struct{ ID string `json:"id"` }
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
	var m2 struct{ ID string `json:"id"` }
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
