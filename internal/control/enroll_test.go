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
	if !strings.Contains(n.DockerCmd, "docker rm -f umbra-node") {
		t.Fatalf("dockerCmd must replace an existing node container: %q", n.DockerCmd)
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

func TestEnrollBinaryScriptsUseNativeSystemServices(t *testing.T) {
	c, _, dir := newTestConsole(t)
	c.HideNodeToken = true
	c.Listen = "114.55.129.94:4400"
	caPath := filepath.Join(dir, "ca.crt")
	if err := os.WriteFile(caPath, []byte(testCAPEM+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	c.CAFile = caPath

	tests := []struct {
		name     string
		platform string
		arch     string
		want     []string
	}{
		{
			name: "linux arm64", platform: "linux", arch: "arm64",
			want: []string{"umbra-node_linux_arm64", "/etc/systemd/system/umbra-node.service", "systemctl enable umbra-node", "systemctl restart umbra-node"},
		},
		{
			name: "macOS amd64", platform: "darwin", arch: "amd64",
			want: []string{"umbra-node_darwin_amd64", "/Library/LaunchDaemons/io.umbra.node.plist", "launchctl bootstrap system", "launchctl kickstart -k system/io.umbra.node"},
		},
		{
			name: "windows arm64", platform: "windows", arch: "arm64",
			want: []string{"umbra-node_windows_arm64.exe", "WindowsBuiltInRole]::Administrator", "New-Service -Name 'UmbraNode'", "$LASTEXITCODE -ne 0", "Start-Service -Name 'UmbraNode'"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd := c.enrollBinScript("umbra_boot_abc", tt.platform, tt.arch)
			for _, want := range tt.want {
				if !strings.Contains(cmd, want) {
					t.Fatalf("command missing %q:\n%s", want, cmd)
				}
			}
			if !strings.Contains(cmd, testCAPEM) || !strings.Contains(cmd, "umbra_boot_abc") {
				t.Fatalf("command must embed CA and token:\n%s", cmd)
			}
			assertTokenNotOnCommandLine(t, cmd)
		})
	}
}

// The install scripts may embed the credential so it can be written to a
// protected file, but the resulting service or container must never carry
// it on its command line, where any local user can read it.
func assertTokenNotOnCommandLine(t *testing.T, cmd string) {
	t.Helper()
	if strings.Contains(cmd, "--token ") || strings.Contains(cmd, "--token '") {
		t.Fatalf("credential passed as a command-line argument:\n%s", cmd)
	}
}

func TestEnrollScriptsKeepCredentialOffCommandLine(t *testing.T) {
	c, _, dir := newTestConsole(t)
	c.HideNodeToken = true
	c.Listen = "114.55.129.94:4400"
	caPath := filepath.Join(dir, "ca.crt")
	if err := os.WriteFile(caPath, []byte(testCAPEM+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	c.CAFile = caPath

	win := c.enrollBinScript("umbra_boot_abc", "windows", "amd64")
	assertTokenNotOnCommandLine(t, win)
	for _, want := range []string{"node.token", "--token-file", "SetAccessRuleProtection($true, $false)", "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"} {
		if !strings.Contains(win, want) {
			t.Fatalf("windows script missing %q:\n%s", want, win)
		}
	}

	for _, withCA := range []bool{true, false} {
		if !withCA {
			c.CAFile = ""
		}
		dk := c.enrollDockerScript("umbra_boot_abc")
		assertTokenNotOnCommandLine(t, dk)
		for _, want := range []string{"umask 077", `printf '%s' 'umbra_boot_abc' >"$HOME/.umbra/node.token"`, `-v "$HOME/.umbra/node.token":/etc/umbra/node.token:ro`, "--token-file /etc/umbra/node.token"} {
			if !strings.Contains(dk, want) {
				t.Fatalf("docker script (ca=%v) missing %q:\n%s", withCA, want, dk)
			}
		}
	}
}

func TestEnrollTokenVisibility(t *testing.T) {
	c, _, _ := newTestConsole(t)
	for _, hide := range []bool{false, true} {
		c.HideNodeToken = hide
		for _, platform := range []string{"linux", "darwin", "windows", "docker"} {
			cmd := c.enrollBinScript("umbra_boot_test", platform, "amd64")
			if platform == "docker" {
				cmd = c.enrollDockerScript("umbra_boot_test")
			}
			if hide {
				assertTokenNotOnCommandLine(t, cmd)
			} else if !strings.Contains(cmd, "--token ") {
				t.Fatalf("%s: default script must pass token in argv", platform)
			}
		}
		if c.enrollFields("umbra_boot_test", "linux", "amd64")["hideNodeToken"] != hide {
			t.Fatal("missing enrollment policy")
		}
	}
}

func TestLocalNodeTokenVisibility(t *testing.T) {
	c := &Console{NodeBin: "/usr/local/bin/umbra-node", Listen: "gate:4400", CAFile: "/etc/umbra/ca.crt"}
	for _, hide := range []bool{false, true} {
		c.HideNodeToken = hide
		cmd := c.nodeCommand("umbra_boot_local")
		args := strings.Join(cmd.Args, " ")
		if hide {
			assertTokenNotOnCommandLine(t, args)
			if strings.Contains(args, "umbra_boot_local") {
				t.Fatal("credential leaked to argv")
			}
			if !strings.Contains(strings.Join(cmd.Env, "\n"), "UMBRA_TOKEN=umbra_boot_local") {
				t.Fatal("missing environment credential")
			}
		} else if !strings.Contains(args, "--token umbra_boot_local") {
			t.Fatal("missing argv credential")
		}
	}
}
