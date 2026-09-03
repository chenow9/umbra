package control

import (
	"bufio"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"umbra/internal/tlscfg"
)

func TestHTTPBindNeedsTLS(t *testing.T) {
	need := []string{":8080", "0.0.0.0:8080", "[::]:8080", "192.168.1.9:8080", "example.com:8080"}
	for _, a := range need {
		if !HTTPBindNeedsTLS(a) {
			t.Fatalf("%s must require TLS", a)
		}
	}
	plain := []string{"127.0.0.1:8080", "[::1]:8080", "localhost:8080", "/tmp/umbra.sock", "unix:/tmp/umbra.sock", "api.sock"}
	for _, a := range plain {
		if HTTPBindNeedsTLS(a) {
			t.Fatalf("%s must allow plain HTTP", a)
		}
	}
	if err := CheckHTTPBind(":8080", false); err == nil {
		t.Fatal("public HTTP without TLS must fail")
	}
	if err := CheckHTTPBind(":8080", true); err != nil {
		t.Fatal(err)
	}
	if err := CheckHTTPBind("127.0.0.1:8080", false); err != nil {
		t.Fatal(err)
	}
}

func TestHTTPSlowlorisCloses(t *testing.T) {
	old := HTTPReadHeaderTimeout
	HTTPReadHeaderTimeout = 80 * time.Millisecond
	t.Cleanup(func() { HTTPReadHeaderTimeout = old })

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	srv := NewHTTPServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
	}))
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("POST /v1/login HTTP/1.1\r\nHost: 127.0.0.1\r\n")); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 1)
	if _, err := c.Read(buf); err == nil {
		t.Fatal("slowloris headers must be closed by ReadHeaderTimeout")
	}
}

func TestHTTPPublicServeRequiresTLS(t *testing.T) {
	dir := t.TempDir()
	bundle, err := tlscfg.Ensure(dir)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	srv := NewHTTPServer(mux)
	go func() { _ = srv.ServeTLS(ln, dir+"/gate.crt", dir+"/gate.key") }()
	t.Cleanup(func() { _ = srv.Close() })

	plain, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	_, _ = plain.Write([]byte("GET /health HTTP/1.1\r\nHost: x\r\n\r\n"))
	_ = plain.SetReadDeadline(time.Now().Add(time.Second))
	br := bufio.NewReader(plain)
	line, _ := br.ReadString('\n')
	_ = plain.Close()
	if strings.HasPrefix(line, "HTTP/1.1 200") || strings.Contains(line, `"ok":true`) {
		t.Fatalf("TLS listener served the app over cleartext: %q", line)
	}

	conf, err := tlscfg.Client(bundle.CAFile)
	if err != nil {
		t.Fatal(err)
	}
	cli := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{TLSClientConfig: conf}}
	res, err := cli.Get("https://" + ln.Addr().String() + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestCookieIgnoresUntrustedForwardedProto(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.RequireTwoFactor = false
	req := httptest.NewRequest("POST", "http://127.0.0.1/v1/setup", strings.NewReader(`{"password":"abcdefgh"}`))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.RemoteAddr = "203.0.113.9:9"
	rr := httptest.NewRecorder()
	srv.Config.Handler.ServeHTTP(rr, req)
	ck := rr.Result().Header.Get("Set-Cookie")
	if strings.Contains(strings.ToLower(ck), "secure") {
		t.Fatalf("untrusted proxy must not mark cookie Secure: %s", ck)
	}

	c.TrustProxy = "127.0.0.0/8"
	req = httptest.NewRequest("POST", "http://127.0.0.1/v1/login", strings.NewReader(`{"password":"abcdefgh"}`))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.RemoteAddr = "127.0.0.1:9"
	rr = httptest.NewRecorder()
	srv.Config.Handler.ServeHTTP(rr, req)
	ck = rr.Result().Header.Get("Set-Cookie")
	if !strings.Contains(strings.ToLower(ck), "secure") {
		t.Fatalf("trusted proxy https must set Secure: %s", ck)
	}
}
