package control

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testCAPEM = `-----BEGIN CERTIFICATE-----
MIIBtest
-----END CERTIFICATE-----`

func TestShQuote(t *testing.T) {
	if shQuote("abc") != "'abc'" {
		t.Fatalf("plain %q", shQuote("abc"))
	}
	if shQuote("a'b") != `'a'"'"'b'` {
		t.Fatalf("quote %q", shQuote("a'b"))
	}
}

func TestEnrollScriptsEmbedCA(t *testing.T) {
	c, srv, dir := newTestConsole(t)
	c.Listen = "114.55.129.94:4400"
	caPath := filepath.Join(dir, "ca.crt")
	if err := os.WriteFile(caPath, []byte(testCAPEM+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	c.CAFile = caPath

	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n-docker"}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("node %d %s", res.StatusCode, readBody(t, res))
	}
	var n struct {
		Token      string `json:"token"`
		InstallCmd string `json:"installCmd"`
		DockerCmd  string `json:"dockerCmd"`
		Listen     string `json:"listen"`
		CAPem      string `json:"caPem"`
	}
	if err := json.NewDecoder(res.Body).Decode(&n); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if n.Token == "" || !strings.HasPrefix(n.Token, "umbra_boot_") {
		t.Fatalf("token %q", n.Token)
	}
	if n.Listen != "114.55.129.94:4400" {
		t.Fatalf("listen %q", n.Listen)
	}
	if n.CAPem != testCAPEM {
		t.Fatalf("caPem %q", n.CAPem)
	}
	for _, cmd := range []string{n.InstallCmd, n.DockerCmd} {
		if !strings.Contains(cmd, "BEGIN CERTIFICATE") {
			t.Fatalf("missing CA in %q", cmd)
		}
		if !strings.Contains(cmd, n.Token) {
			t.Fatalf("missing token in %q", cmd)
		}
		if !strings.Contains(cmd, "114.55.129.94:4400") {
			t.Fatalf("missing server in %q", cmd)
		}
		if !strings.Contains(cmd, "不必再下载或 scp") {
			t.Fatalf("copy should say CA is already in the command: %q", cmd)
		}
	}
	if !strings.Contains(n.InstallCmd, "umbra-node --server") {
		t.Fatalf("installCmd %q", n.InstallCmd)
	}
	if !strings.Contains(n.DockerCmd, "docker run") {
		t.Fatalf("dockerCmd missing docker run: %q", n.DockerCmd)
	}
	if !strings.Contains(n.DockerCmd, nodeDockerImage) {
		t.Fatalf("dockerCmd missing image: %q", n.DockerCmd)
	}
	if !strings.Contains(n.DockerCmd, "--network host") {
		t.Fatalf("dockerCmd missing host net: %q", n.DockerCmd)
	}
	if !strings.Contains(n.DockerCmd, `$HOME/.umbra/ca.crt`) {
		t.Fatalf("dockerCmd should persist CA under $HOME/.umbra: %q", n.DockerCmd)
	}
	if strings.Contains(n.DockerCmd, "/Users/") || strings.Contains(n.DockerCmd, "Downloads") {
		t.Fatalf("dockerCmd must not use a laptop path: %q", n.DockerCmd)
	}
}

func TestEnrollScriptsWithoutCA(t *testing.T) {
	c, srv, _ := newTestConsole(t)
	c.Listen = "gate.example.com:4400"
	res := doJSON(t, srv, "POST", "/v1/nodes", map[string]string{"name": "n2"}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("node %d %s", res.StatusCode, readBody(t, res))
	}
	var n struct {
		Token      string `json:"token"`
		ID         string `json:"id"`
		InstallCmd string `json:"installCmd"`
		DockerCmd  string `json:"dockerCmd"`
		CAPem      string `json:"caPem"`
	}
	if err := json.NewDecoder(res.Body).Decode(&n); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if n.CAPem != "" {
		t.Fatalf("caPem should be empty, got %q", n.CAPem)
	}
	if !strings.Contains(n.DockerCmd, "docker run") {
		t.Fatalf("dockerCmd %q", n.DockerCmd)
	}
	if strings.Contains(n.DockerCmd, "BEGIN CERTIFICATE") {
		t.Fatalf("should not invent a CA: %q", n.DockerCmd)
	}
	if !strings.Contains(n.DockerCmd, "$PWD/ca.crt") {
		t.Fatalf("without CA, dockerCmd should mount ./ca.crt: %q", n.DockerCmd)
	}
	if !strings.Contains(n.InstallCmd, "umbra-node --server") {
		t.Fatalf("installCmd %q", n.InstallCmd)
	}

	res = doJSON(t, srv, "POST", "/v1/nodes/"+n.ID+"/rotate", nil, nil)
	if res.StatusCode != 200 {
		t.Fatalf("rotate %d %s", res.StatusCode, readBody(t, res))
	}
	var rot struct {
		DockerCmd  string `json:"dockerCmd"`
		InstallCmd string `json:"installCmd"`
		Token      string `json:"token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&rot); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if rot.Token == "" || rot.Token == n.Token {
		t.Fatalf("rotate token %q", rot.Token)
	}
	if !strings.Contains(rot.DockerCmd, rot.Token) {
		t.Fatalf("rotate dockerCmd missing new token: %q", rot.DockerCmd)
	}
	if !strings.Contains(rot.InstallCmd, rot.Token) {
		t.Fatalf("rotate installCmd missing new token: %q", rot.InstallCmd)
	}
}
