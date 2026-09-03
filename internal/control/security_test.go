package control

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestReplacePendingInvalidatedByPasswordChange(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.RequireTwoFactor = true
	owner := cookieClient(t)
	codes := enrollOwner(t, c, srv, owner, "abcdefgh")
	raw, err := decodeTOTPSecret(c.twoFactor.Secret)
	if err != nil {
		t.Fatal(err)
	}
	totp := totpAt(raw, time.Now().Add(totpPeriod*time.Second))
	body, _ := json.Marshal(map[string]string{"password": "abcdefgh", "totp": totp})
	req, _ := http.NewRequest("POST", srv.URL+"/v1/2fa/replace", strings.NewReader(string(body)))
	req.Header.Set("content-type", "application/json")
	res, err := owner.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("replace start %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	res, err = owner.Get(srv.URL + "/v1/2fa/enrollment")
	if err != nil {
		t.Fatal(err)
	}
	var en enrollView
	if err := json.NewDecoder(res.Body).Decode(&en); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	pendingRaw, err := decodeTOTPSecret(en.Secret)
	if err != nil {
		t.Fatal(err)
	}

	u := res.Request.URL
	stolen, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	stolen.SetCookies(u, owner.Jar.Cookies(u))
	attacker := &http.Client{Jar: stolen}

	pwBody, _ := json.Marshal(map[string]string{
		"current": "abcdefgh", "new": "newpassword", "recoveryCode": codes[0],
	})
	req, _ = http.NewRequest("POST", srv.URL+"/v1/password", strings.NewReader(string(pwBody)))
	req.Header.Set("content-type", "application/json")
	res, err = owner.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("password change %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	confirm := totpAt(pendingRaw, time.Now())
	req, _ = http.NewRequest("POST", srv.URL+"/v1/2fa/enrollment/confirm", strings.NewReader(`{"code":"`+confirm+`"}`))
	req.Header.Set("content-type", "application/json")
	res, err = attacker.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("stale replace pending must not confirm after password change %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)

	res, err = attacker.Get(srv.URL + "/v1/overview")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("attacker session %d %s", res.StatusCode, readBody(t, res))
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
}

func TestHTTPLoginRejectsConcurrentTOTPReplay(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.RequireTwoFactor = true
	cli := cookieClient(t)
	enrollOwner(t, c, srv, cli, "abcdefgh")
	raw, err := decodeTOTPSecret(c.twoFactor.Secret)
	if err != nil {
		t.Fatal(err)
	}
	code := totpAt(raw, time.Now().Add(totpPeriod*time.Second))
	body, _ := json.Marshal(map[string]string{"password": "abcdefgh", "totp": code})
	var okN atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, _ := http.NewRequest("POST", srv.URL+"/v1/login", strings.NewReader(string(body)))
			req.Header.Set("content-type", "application/json")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				return
			}
			if res.StatusCode == 200 {
				okN.Add(1)
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
		}()
	}
	wg.Wait()
	if okN.Load() != 1 {
		t.Fatalf("want 1 TOTP login, got %d", okN.Load())
	}
}

func TestRecoveryCodeConcurrentUse(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.RequireTwoFactor = true
	cli := cookieClient(t)
	codes := enrollOwner(t, c, srv, cli, "abcdefgh")
	body, _ := json.Marshal(map[string]string{"password": "abcdefgh", "recoveryCode": codes[0]})
	var okN atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, _ := http.NewRequest("POST", srv.URL+"/v1/login", strings.NewReader(string(body)))
			req.Header.Set("content-type", "application/json")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				return
			}
			if res.StatusCode == 200 {
				okN.Add(1)
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
		}()
	}
	wg.Wait()
	if okN.Load() != 1 {
		t.Fatalf("want 1 recovery login, got %d", okN.Load())
	}
}

func TestAuthRateReservesBeforeHash(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.RequireTwoFactor = false
	if err := c.setup("abcdefgh"); err != nil {
		t.Fatal(err)
	}
	hashPeak.Store(0)
	hashInFlight.Store(0)
	body := `{"password":"wrongwrong"}`
	var wg sync.WaitGroup
	var limited atomic.Int32
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, _ := http.NewRequest("POST", srv.URL+"/v1/login", strings.NewReader(body))
			req.Header.Set("content-type", "application/json")
			req.RemoteAddr = "203.0.113.9:9"
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				return
			}
			if res.StatusCode == http.StatusTooManyRequests {
				limited.Add(1)
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
		}()
	}
	wg.Wait()
	if hashPeak.Load() > int32(maxParallelPasswordHash) {
		t.Fatalf("parallel hashes %d", hashPeak.Load())
	}
	if limited.Load() < 20 {
		t.Fatalf("expected many 429, got %d; peak hash %d", limited.Load(), hashPeak.Load())
	}
}

func TestReauthEndpointsUseRateLimit(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.RequireTwoFactor = true
	cli := cookieClient(t)
	enrollOwner(t, c, srv, cli, "abcdefgh")
	for i := 0; i < 8; i++ {
		req, _ := http.NewRequest("POST", srv.URL+"/v1/password", strings.NewReader(`{"current":"badpassw","new":"newpassword","totp":"000000"}`))
		req.Header.Set("content-type", "application/json")
		res, err := cli.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}
	req, _ := http.NewRequest("POST", srv.URL+"/v1/2fa/replace", strings.NewReader(`{"password":"abcdefgh","totp":"000000"}`))
	req.Header.Set("content-type", "application/json")
	res, err := cli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("replace after failures %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
}

func TestIssueSessionFailsClosedOnRandError(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.RequireTwoFactor = false
	if err := c.setup("abcdefgh"); err != nil {
		t.Fatal(err)
	}
	old := randRead
	randRead = func([]byte) (int, error) { return 0, errors.New("rand exhausted") }
	defer func() { randRead = old }()
	req, _ := http.NewRequest("POST", srv.URL+"/v1/login", strings.NewReader(`{"password":"abcdefgh"}`))
	req.Header.Set("content-type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode == 200 {
		t.Fatalf("rand failure must not issue session: %s", readBody(t, res))
	}
	readBody(t, res)
}

func TestLockHelperProcess(t *testing.T) {
	if os.Getenv("UMBRA_LOCK_HELPER") != "1" {
		return
	}
	f, err := AcquireControlLock(os.Getenv("UMBRA_LOCK_PATH"))
	if err != nil {
		os.Stderr.WriteString(err.Error())
		os.Exit(2)
	}
	os.Stdout.WriteString("locked\n")
	os.Stdout.Sync()
	buf := make([]byte, 1)
	os.Stdin.Read(buf)
	f.Close()
	os.Exit(0)
}

func TestControlLockBlocksOtherProcess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "control.json")
	cmd := exec.Command(os.Args[0], "-test.run=^TestLockHelperProcess$")
	cmd.Env = append(os.Environ(), "UMBRA_LOCK_HELPER=1", "UMBRA_LOCK_PATH="+path)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 16)
	n, err := stdout.Read(got)
	if err != nil || !strings.Contains(string(got[:n]), "locked") {
		t.Fatalf("helper: %q %v", got[:n], err)
	}
	if _, err := AcquireControlLock(path); err == nil {
		stdin.Close()
		cmd.Wait()
		t.Fatal("second process must not acquire lock")
	}
	stdin.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	f, err := AcquireControlLock(path)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
}

func TestRateLimitedRequestsDoNotFloodLogs(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.RequireTwoFactor = false
	if err := c.setup("abcdefgh"); err != nil {
		t.Fatal(err)
	}
	rateLimitLogNS.Store(0)
	rateLimitLogCount.Store(0)
	body := `{"password":"wrongwrong"}`
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, _ := http.NewRequest("POST", srv.URL+"/v1/login", strings.NewReader(body))
			req.Header.Set("content-type", "application/json")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				return
			}
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
		}()
	}
	wg.Wait()
	if n := rateLimitLogCount.Load(); n > 2 {
		t.Fatalf("rate-limit logs %d, want at most 2", n)
	}
}

func TestRecoveryConsumeSurvivesTombCommit(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.RequireTwoFactor = true
	cli := cookieClient(t)
	codes := enrollOwner(t, c, srv, cli, "abcdefgh")
	afterTombHook = func() error { return errors.New("disk full") }
	t.Cleanup(func() { afterTombHook = nil })
	_, err := c.loginFactors(loginInput{Password: "abcdefgh", Recovery: codes[0], IP: "10.0.0.1"})
	if err == nil {
		t.Fatal("want persist failure")
	}
	if !persistTombCommitted(err) {
		t.Fatalf("want tomb-committed error, got %v", err)
	}
	c.mu.Lock()
	left := len(c.twoFactor.RecoveryCodes)
	c.mu.Unlock()
	if left != 9 {
		t.Fatalf("consumed recovery must stay consumed after tomb commit, left %d", left)
	}
}

func TestNewIDFailureDoesNotMintToken(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = true
	old := randRead
	randRead = func([]byte) (int, error) { return 0, errors.New("rand exhausted") }
	t.Cleanup(func() { randRead = old })
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n1"}, nil)
	if res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
	c.mu.Lock()
	n := len(c.nodes)
	c.mu.Unlock()
	if n != 0 {
		t.Fatalf("node created despite rand failure: %d", n)
	}
}

func TestBeginDrainRejectsAPI(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.BeginDrain()
	res := doJSON(t, srv, "GET", "/v1/overview", nil, nil)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("drain %d %s", res.StatusCode, readBody(t, res))
	}
	readBody(t, res)
}

func TestDrainHTTPAbortsWhenHandlerBlocked(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	hold := make(chan struct{})
	c.SetHTTPStall(func() { <-hold })
	done := make(chan struct{})
	go func() {
		defer close(done)
		res, err := http.Get(srv.URL + "/v1/overview")
		if err == nil {
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
		}
	}()
	deadline := time.Now().Add(2 * time.Second)
	for c.httpActive.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if c.httpActive.Load() == 0 {
		close(hold)
		<-done
		t.Fatal("handler did not start")
	}
	if c.DrainHTTP(80 * time.Millisecond) {
		close(hold)
		<-done
		t.Fatal("drain succeeded while handler blocked")
	}
	c.SetHTTPStall(nil)
	res := doJSON(t, srv, "GET", "/v1/overview", nil, nil)
	if res.StatusCode == http.StatusServiceUnavailable {
		readBody(t, res)
		close(hold)
		<-done
		t.Fatal("aborted drain must resume API")
	}
	readBody(t, res)
	close(hold)
	<-done
	if !c.DrainHTTP(time.Second) {
		t.Fatal("drain after handler returned")
	}
}

func TestLockHandoffBlocksAcquire(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "control.json")
	if err := WriteLockHandoff(path, "nonce-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireControlLock(path); err == nil {
		t.Fatal("acquire must fail during handoff")
	}
	ClearLockHandoff(path)
	f, err := AcquireControlLock(path)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
}

func TestLockHandoffHelperProcess(t *testing.T) {
	if os.Getenv("UMBRA_LOCK_HANDOFF_HELPER") != "1" {
		return
	}
	f, err := AcquireControlLockHandoff(os.Getenv("UMBRA_LOCK_PATH"), os.Getenv("UMBRA_LOCK_NONCE"), 5*time.Second)
	if err != nil {
		os.Stderr.WriteString(err.Error())
		os.Exit(2)
	}
	os.Stdout.WriteString("locked\n")
	os.Stdout.Sync()
	buf := make([]byte, 1)
	os.Stdin.Read(buf)
	f.Close()
	os.Exit(0)
}

func TestLockHandoffParentChild(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "control.json")
	parent, err := AcquireControlLock(path)
	if err != nil {
		t.Fatal(err)
	}
	nonce := "handoff-test-nonce"
	if err := WriteLockHandoff(path, nonce); err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireControlLock(path); err == nil {
		parent.Close()
		t.Fatal("third party acquired during handoff")
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestLockHandoffHelperProcess$")
	cmd.Env = append(os.Environ(),
		"UMBRA_LOCK_HANDOFF_HELPER=1",
		"UMBRA_LOCK_PATH="+path,
		"UMBRA_LOCK_NONCE="+nonce,
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if err := parent.Close(); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 16)
	n, err := stdout.Read(got)
	if err != nil || !strings.Contains(string(got[:n]), "locked") {
		_ = cmd.Process.Kill()
		t.Fatalf("child: %q %v", got[:n], err)
	}
	if _, err := AcquireControlLock(path); err == nil {
		stdin.Close()
		cmd.Wait()
		t.Fatal("third party acquired while child holds lock")
	}
	if lockHandoffNonce(path) != "" {
		stdin.Close()
		cmd.Wait()
		t.Fatal("handoff file should be cleared after child lock")
	}
	stdin.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	f, err := AcquireControlLock(path)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
}
