package control

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"umbra/internal/gate"
	"umbra/internal/stealth"
)

func TestParseTwoFactorEnv(t *testing.T) {
	on, err := ParseTwoFactorEnv("")
	if err != nil || !on {
		t.Fatalf("default %v %v", on, err)
	}
	on, err = ParseTwoFactorEnv(" OFF ")
	if err != nil || on {
		t.Fatalf("off %v %v", on, err)
	}
	if _, err := ParseTwoFactorEnv("maybe"); err == nil {
		t.Fatal("illegal")
	}
}

func TestTwoFactorEnrollmentRequiredBeforeSession(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.RequireTwoFactor = true
	cli := cookieClient(t)
	req, _ := http.NewRequest("POST", srv.URL+"/v1/setup", strings.NewReader(`{"password":"abcdefgh"}`))
	req.Header.Set("content-type", "application/json")
	res, err := cli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var setup struct {
		OK   bool   `json:"ok"`
		Next string `json:"next"`
	}
	if err := json.NewDecoder(res.Body).Decode(&setup); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 || setup.Next != "enroll_2fa" {
		t.Fatalf("setup %d %+v", res.StatusCode, setup)
	}
	res, err = cli.Get(srv.URL + "/v1/overview")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("overview before enroll %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	res, err = cli.Get(srv.URL + "/v1/2fa/enrollment")
	if err != nil {
		t.Fatal(err)
	}
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("cache %q", res.Header.Get("Cache-Control"))
	}
	var en enrollView
	if err := json.NewDecoder(res.Body).Decode(&en); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if en.Secret == "" || en.OTPAuthURI == "" {
		t.Fatalf("enrollment %+v", en)
	}
	raw, err := decodeTOTPSecret(en.Secret)
	if err != nil {
		t.Fatal(err)
	}
	code := totpAt(raw, time.Now())
	req, _ = http.NewRequest("POST", srv.URL+"/v1/2fa/enrollment/confirm", strings.NewReader(`{"code":"`+code+`"}`))
	req.Header.Set("content-type", "application/json")
	res, err = cli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var conf struct {
		OK            bool     `json:"ok"`
		Next          string   `json:"next"`
		RecoveryCodes []string `json:"recoveryCodes"`
	}
	if err := json.NewDecoder(res.Body).Decode(&conf); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 || len(conf.RecoveryCodes) != 10 {
		t.Fatalf("confirm %d %+v", res.StatusCode, conf)
	}
	res, err = cli.Get(srv.URL + "/v1/overview")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("overview after enroll %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	cli2 := cookieClient(t)
	req, _ = http.NewRequest("POST", srv.URL+"/v1/login", strings.NewReader(`{"password":"abcdefgh"}`))
	req.Header.Set("content-type", "application/json")
	res, err = cli2.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("password only %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	code = totpAt(raw, time.Now().Add(totpPeriod*time.Second))
	body, _ := json.Marshal(map[string]string{"password": "abcdefgh", "totp": code})
	req, _ = http.NewRequest("POST", srv.URL+"/v1/login", strings.NewReader(string(body)))
	req.Header.Set("content-type", "application/json")
	res, err = cli2.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("totp login %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	cli3 := cookieClient(t)
	recBody, _ := json.Marshal(map[string]string{"password": "abcdefgh", "recoveryCode": conf.RecoveryCodes[0]})
	req, _ = http.NewRequest("POST", srv.URL+"/v1/login", strings.NewReader(string(recBody)))
	req.Header.Set("content-type", "application/json")
	res, err = cli3.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("recovery login %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
	res, err = cli2.Get(srv.URL + "/v1/overview")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("old session after recovery %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
}

func TestSchema1UpgradeRequiresMigration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "control.json")
	h, err := hashPassword("oldpassword")
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(persistFile{OwnerEpoch: 1, OwnerHash: h, OwnerSecret: "abc"})
	box := persistBox{Schema: 1, Checksum: persistChecksum(payload), Payload: payload}
	raw, _ := json.MarshalIndent(box, "", "  ")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	g := gate.New("127.0.0.1", stealth.New(false))
	c, err := New(g, path)
	if err != nil {
		t.Fatal(err)
	}
	if !c.migratedFromV1 || c.migrationHash == "" {
		t.Fatal("expected migration material")
	}
	b, err := os.ReadFile(BootstrapPath(path))
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	if !strings.Contains(text, "迁移码") {
		t.Fatalf("bootstrap %s", text)
	}
	code := ""
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.Count(line, "-") == 3 && len(line) >= 32 {
			code = line
			break
		}
	}
	if code == "" {
		t.Fatalf("no code in %s", text)
	}
	c.SkipAuth = false
	c.RequireTwoFactor = true
	_, err = c.loginFactors(loginInput{Password: "oldpassword", IP: "1.1.1.1"})
	if err == nil {
		t.Fatal("password without migration")
	}
	res, err := c.loginFactors(loginInput{Password: "oldpassword", Migration: code, IP: "1.1.1.1"})
	if err != nil || res.Next != "enroll_2fa" || res.PreAuth == "" {
		t.Fatalf("migrate login %v %+v", err, res)
	}
}

func TestTwoFactorOffCannotReplace(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.RequireTwoFactor = true
	cli := cookieClient(t)
	enrollOwner(t, c, srv, cli, "abcdefgh")
	c.RequireTwoFactor = false
	req, _ := http.NewRequest("POST", srv.URL+"/v1/login", strings.NewReader(`{"password":"abcdefgh"}`))
	req.Header.Set("content-type", "application/json")
	res, err := cli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("password-only while off %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
	req, _ = http.NewRequest("POST", srv.URL+"/v1/2fa/replace", strings.NewReader(`{"password":"abcdefgh","totp":"000000"}`))
	req.Header.Set("content-type", "application/json")
	res, err = cli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("replace while off %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
}

func TestPasswordOnlySessionRejectedWhenTwoFactorReenabled(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.RequireTwoFactor = true
	cli := cookieClient(t)
	enrollOwner(t, c, srv, cli, "abcdefgh")
	c.RequireTwoFactor = false
	off := cookieClient(t)
	req, _ := http.NewRequest("POST", srv.URL+"/v1/login", strings.NewReader(`{"password":"abcdefgh"}`))
	req.Header.Set("content-type", "application/json")
	res, err := off.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, res)
	c.RequireTwoFactor = true
	res, err = off.Get(srv.URL + "/v1/overview")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("password-only after reenable %d %s", res.StatusCode, readBody(t, res))
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
}

func TestResetTwoFactorNeedsStoppedDaemon(t *testing.T) {
	c, _, dir := newTestConsole(t)
	c.SkipAuth = false
	c.RequireTwoFactor = true
	if err := c.setup("abcdefgh"); err != nil {
		t.Fatal(err)
	}
	if err := c.HoldLock(); err != nil {
		t.Fatal(err)
	}
	defer c.ReleaseLock()
	err := ResetTwoFactor(filepath.Join(dir, "control.json"))
	if err == nil {
		t.Fatal("reset must fail while lock is held")
	}
	c.ReleaseLock()
	if err := ResetTwoFactor(filepath.Join(dir, "control.json")); err != nil {
		t.Fatal(err)
	}
	if c2, err := New(c.Gate, c.Persist); err != nil {
		t.Fatal(err)
	} else if c2.twoFactor.Confirmed {
		t.Fatal("reset must clear binding")
	}
	if _, err := os.Stat(BootstrapPath(c.Persist)); err != nil {
		t.Fatal("bootstrap after reset")
	}
}

func enrollOwner(t *testing.T, _ *Console, srv *httptest.Server, cli *http.Client, pw string) []string {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/v1/setup", strings.NewReader(`{"password":"`+pw+`"}`))
	req.Header.Set("content-type", "application/json")
	res, err := cli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("setup %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
	res, err = cli.Get(srv.URL + "/v1/2fa/enrollment")
	if err != nil {
		t.Fatal(err)
	}
	var en enrollView
	if err := json.NewDecoder(res.Body).Decode(&en); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	raw, err := decodeTOTPSecret(en.Secret)
	if err != nil {
		t.Fatal(err)
	}
	code := totpAt(raw, time.Now())
	req, _ = http.NewRequest("POST", srv.URL+"/v1/2fa/enrollment/confirm", strings.NewReader(`{"code":"`+code+`"}`))
	req.Header.Set("content-type", "application/json")
	res, err = cli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var conf struct {
		RecoveryCodes []string `json:"recoveryCodes"`
	}
	if err := json.NewDecoder(res.Body).Decode(&conf); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 || len(conf.RecoveryCodes) != 10 {
		t.Fatalf("confirm %d %+v", res.StatusCode, conf)
	}
	return conf.RecoveryCodes
}
