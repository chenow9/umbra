package control

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUIAssetDirectoryIsNotListed(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	for _, p := range []string{"/assets/", "/assets"} {
		res, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		body := readBody(t, res)
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("%s status %d %s", p, res.StatusCode, body)
		}
		if strings.Contains(body, "<a href=") || strings.Contains(body, "<pre>") {
			t.Fatalf("%s listed files: %s", p, body)
		}
	}
}

func TestUIMissingAssetIsNotIndex(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	res, err := http.Get(srv.URL + "/assets/does-not-exist.js")
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, res)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d %s", res.StatusCode, body)
	}
}

func TestUISPAFallbackStillWorks(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	res, err := http.Get(srv.URL + "/login")
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, res)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d %s", res.StatusCode, body)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "html") {
		t.Fatalf("spa content-type %q", ct)
	}
}

func TestUIDirAssetDirectoryIsNotListed(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>ok</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "app.js"), []byte("console.log(1)"), 0o644); err != nil {
		t.Fatal(err)
	}
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.UIDir = dir

	res, err := http.Get(srv.URL + "/assets/")
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, res)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("dir status %d %s", res.StatusCode, body)
	}
	if strings.Contains(body, "app.js") {
		t.Fatalf("listed files: %s", body)
	}

	res, err = http.Get(srv.URL + "/assets/app.js")
	if err != nil {
		t.Fatal(err)
	}
	body = readBody(t, res)
	if res.StatusCode != http.StatusOK || !strings.Contains(body, "console.log") {
		t.Fatalf("file status %d %s", res.StatusCode, body)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Fatalf("asset content-type %q", ct)
	}
}

func TestSecurityHeadersOnAPIAndUI(t *testing.T) {
	dir := t.TempDir()
	inline := `(function(){document.documentElement.lang="en"})();`
	doc := `<html><head><script>` + inline + `</script><script type="module" src="/assets/app.js"></script></head><body>ok</body></html>`
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	c.UIDir = dir

	res, err := http.Get(srv.URL + "/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, res)
	if got := res.Header.Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("api X-Frame-Options %q", got)
	}
	if got := res.Header.Get("Content-Security-Policy"); !strings.Contains(got, "default-src 'none'") || !strings.Contains(got, "frame-ancestors 'none'") {
		t.Fatalf("api CSP %q", got)
	}
	if got := res.Header.Get("Strict-Transport-Security"); got != "" {
		t.Fatalf("HSTS must not be sent over plain HTTP, got %q", got)
	}

	sum := sha256.Sum256([]byte(inline))
	wantHash := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	for _, p := range []string{"/", "/login"} {
		res, err = http.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		readBody(t, res)
		csp := res.Header.Get("Content-Security-Policy")
		if !strings.Contains(csp, "script-src 'self' "+wantHash) {
			t.Fatalf("%s CSP lacks inline hash: %q", p, csp)
		}
		if strings.Contains(csp, "unsafe-inline'") && !strings.Contains(csp, "style-src 'self' 'unsafe-inline'") {
			t.Fatalf("%s CSP allows unsafe-inline outside style-src: %q", p, csp)
		}
		if strings.Contains(strings.SplitN(csp, "style-src", 2)[0], "unsafe-inline") {
			t.Fatalf("%s script-src must not allow unsafe-inline: %q", p, csp)
		}
		if !strings.Contains(csp, "frame-ancestors 'none'") || !strings.Contains(csp, "object-src 'none'") {
			t.Fatalf("%s CSP %q", p, csp)
		}
		if got := res.Header.Get("X-Frame-Options"); got != "DENY" {
			t.Fatalf("%s X-Frame-Options %q", p, got)
		}
	}

	// Assets are not documents; they keep the API policy rather than the
	// document policy.
	if err := os.Mkdir(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "app.js"), []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err = http.Get(srv.URL + "/assets/app.js")
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, res)
	if got := res.Header.Get("Content-Security-Policy"); got != apiCSP {
		t.Fatalf("asset CSP %q", got)
	}
}

func TestEmbeddedUIInlineScriptsAreHashed(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	res, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, res)
	csp := res.Header.Get("Content-Security-Policy")
	n := strings.Count(csp, "'sha256-")
	want := len(inlineScriptHashes([]byte(body)))
	if n != want || (strings.Contains(body, "<script>") && n == 0) {
		t.Fatalf("embedded index.html has %d inline scripts, CSP carries %d hashes: %q", want, n, csp)
	}
}

// The browser hashes the parsed script text, in which NUL and CRLF have
// been rewritten; the header must be computed the same way or the hash
// never matches (the built UI actually ships a NUL in one inline script).
func TestInlineScriptHashesUseParsedText(t *testing.T) {
	raw := []byte("<script>a=\"x\x00y\";\r\nb=1</script><script src=\"/a.js\"></script>")
	parsed := "a=\"x\uFFFDy\";\nb=1"
	sum := sha256.Sum256([]byte(parsed))
	want := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	got := inlineScriptHashes(raw)
	if len(got) != 1 || got[0] != want {
		t.Fatalf("hashes %v, want [%s]", got, want)
	}
}

func TestHSTSOnlyOverTLS(t *testing.T) {
	c, _, _ := newTestConsole(t)
	c.TrustProxy = "127.0.0.0/8"
	h := c.Handler()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/health", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Strict-Transport-Security"); got != "" {
		t.Fatalf("plain HTTP from proxy without X-Forwarded-Proto got HSTS %q", got)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/health", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("X-Forwarded-Proto", "https")
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Strict-Transport-Security"); !strings.HasPrefix(got, "max-age=") {
		t.Fatalf("https via trusted proxy lacks HSTS: %q", got)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/health", nil)
	req.RemoteAddr = "203.0.113.5:1234"
	req.Header.Set("X-Forwarded-Proto", "https")
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Strict-Transport-Security"); got != "" {
		t.Fatalf("untrusted proxy header must not enable HSTS: %q", got)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/health", nil)
	req.TLS = &tls.ConnectionState{}
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Strict-Transport-Security"); !strings.HasPrefix(got, "max-age=") {
		t.Fatalf("direct TLS lacks HSTS: %q", got)
	}
}
