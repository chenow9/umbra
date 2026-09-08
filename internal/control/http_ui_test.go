package control

import (
	"io/fs"
	"net/http"
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

func TestUIAssetFileStillServedUnauthenticated(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.SkipAuth = false
	entries, err := fs.ReadDir(uiFS, "ui/assets")
	if err != nil {
		t.Fatal(err)
	}
	var name string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".js") {
			name = e.Name()
			break
		}
	}
	if name == "" {
		t.Fatal("no embedded js asset")
	}
	res, err := http.Get(srv.URL + "/assets/" + name)
	if err != nil {
		t.Fatal(err)
	}
	body := readBody(t, res)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("asset %s status %d %s", name, res.StatusCode, body)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "javascript") {
		t.Fatalf("asset content-type %q", ct)
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
}
