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

const testNodeID = "nde_abc"

func assertLeavesLegacyInstall(t *testing.T, cmd string) {
	t.Helper()
	legacy := []string{
		"/etc/systemd/system/umbra-node.service",
		"systemctl enable umbra-node\n",
		"systemctl enable umbra-node ",
		"systemctl restart umbra-node\n",
		"systemctl restart umbra-node ",
		"/etc/umbra/node.env",
		"tee /etc/umbra/ca.crt",
		"./ca.crt /etc/umbra/ca.crt",
		"/Library/LaunchDaemons/io.umbra.node.plist",
		"system/io.umbra.node\n",
		"system/io.umbra.node ",
		"/usr/local/libexec/umbra-node-run",
		"/usr/local/etc/umbra/ca.crt",
		"/usr/local/etc/umbra/node.token",
		"/usr/local/etc/umbra/server",
		"Name 'UmbraNode'",
		"sc.exe delete UmbraNode\n",
		"sc.exe delete UmbraNode ",
		"docker rm -f umbra-node\n",
		"docker rm -f umbra-node ",
		"--name umbra-node ",
		"--name umbra-node \\",
		"$HOME/.umbra/ca.crt",
		"$HOME/.umbra/node.token",
	}
	for _, s := range legacy {
		if strings.Contains(cmd, s) {
			t.Fatalf("command still targets the shared install %q:\n%s", s, cmd)
		}
	}
}

func TestNodeInstanceKey(t *testing.T) {
	key, err := nodeInstanceKey("NDE_AbC")
	if err != nil || key != "nde-abc" {
		t.Fatalf("key %q err %v", key, err)
	}
	long := "nde_0123456789abcdef0123456789abcdef"
	key, err = nodeInstanceKey(long)
	if err != nil || key != "nde-0123456789abcdef0123456789abcdef" {
		t.Fatalf("key %q err %v", key, err)
	}
	for _, id := range []string{"", "../etc", "nde abc", "nde/abc", "-nde", "nde-"} {
		if _, err := nodeInstanceKey(id); err == nil {
			t.Fatalf("accepted %q", id)
		}
	}
}

func TestEnrollScriptsIsolateNodes(t *testing.T) {
	c, _, _ := newTestConsole(t)
	c.Listen = "gate.example.com:4400"
	a, err := c.enrollLinuxScript("nde_aaa", "tok-a", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	b, err := c.enrollLinuxScript("nde_bbb", "tok-b", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(a, "nde-bbb") || strings.Contains(a, "tok-b") || !strings.Contains(a, "umbra-node-nde-aaa") {
		t.Fatalf("linux a leaked or missed its identity:\n%s", a)
	}
	if strings.Contains(b, "nde-aaa") || strings.Contains(b, "tok-a") || !strings.Contains(b, "/usr/local/bin/umbra-node") {
		t.Fatalf("linux b leaked or dropped the shared binary:\n%s", b)
	}
	again, err := c.enrollDockerScript("nde_aaa", "tok-a2")
	if err != nil {
		t.Fatal(err)
	}
	other, err := c.enrollDockerScript("nde_bbb", "tok-b")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(again, "--name umbra-node-nde-aaa ") || strings.Contains(again, "nde-bbb") || strings.Contains(again, "tok-a\n") {
		t.Fatalf("reinstall did not stay on the same container:\n%s", again)
	}
	if strings.Contains(other, "nde-aaa") || !strings.Contains(other, "--name umbra-node-nde-bbb ") {
		t.Fatalf("other container collided:\n%s", other)
	}
	assertLeavesLegacyInstall(t, a)
	assertLeavesLegacyInstall(t, again)
}

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
		ID         string `json:"id"`
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
	key, err := nodeInstanceKey(n.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(n.DockerCmd, "docker rm -f umbra-node-"+key) {
		t.Fatalf("dockerCmd must replace this node's container: %q", n.DockerCmd)
	}
	if !strings.Contains(n.DockerCmd, `$HOME/.umbra/`+key+`/ca.crt`) {
		t.Fatalf("dockerCmd should persist CA under this node's directory: %q", n.DockerCmd)
	}
	if !strings.Contains(n.InstallCmd, "umbra-node-"+key) {
		t.Fatalf("installCmd missing node service: %q", n.InstallCmd)
	}
	assertLeavesLegacyInstall(t, n.InstallCmd)
	assertLeavesLegacyInstall(t, n.DockerCmd)
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
	key, err := nodeInstanceKey(n.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(n.DockerCmd, "--name umbra-node-"+key+" ") {
		t.Fatalf("dockerCmd missing this node's container: %q", n.DockerCmd)
	}
	assertLeavesLegacyInstall(t, n.InstallCmd)
	assertLeavesLegacyInstall(t, n.DockerCmd)

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
	if !strings.Contains(rot.DockerCmd, "--name umbra-node-"+key+" ") || !strings.Contains(rot.InstallCmd, "umbra-node-"+key) {
		t.Fatalf("rotate changed the node install identity:\n%s\n%s", rot.InstallCmd, rot.DockerCmd)
	}
	assertLeavesLegacyInstall(t, rot.InstallCmd)
	assertLeavesLegacyInstall(t, rot.DockerCmd)
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
			want: []string{"umbra-node_linux_arm64", "/etc/systemd/system/umbra-node-nde-abc.service", "systemctl enable umbra-node-nde-abc", "systemctl restart umbra-node-nde-abc", "/usr/local/bin/umbra-node"},
		},
		{
			name: "macOS amd64", platform: "darwin", arch: "amd64",
			want: []string{"umbra-node_darwin_amd64", "/Library/LaunchDaemons/io.umbra.node.nde-abc.plist", "launchctl bootstrap system", "launchctl kickstart -k system/io.umbra.node.nde-abc", "/usr/local/bin/umbra-node"},
		},
		{
			name: "windows arm64", platform: "windows", arch: "arm64",
			want: []string{"umbra-node_windows_arm64.exe", "WindowsBuiltInRole]::Administrator", "$serviceName = 'UmbraNode-nde-abc'", "New-Service -Name $serviceName", "$LASTEXITCODE -ne 0", "Start-Service -Name $serviceName", "--service-name", "Test-Path -LiteralPath $exe", "Write-Warning"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd, err := c.enrollBinScript(testNodeID, "umbra_boot_abc", tt.platform, tt.arch)
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range tt.want {
				if !strings.Contains(cmd, want) {
					t.Fatalf("command missing %q:\n%s", want, cmd)
				}
			}
			assertLeavesLegacyInstall(t, cmd)
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

	win, err := c.enrollBinScript(testNodeID, "umbra_boot_abc", "windows", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	assertTokenNotOnCommandLine(t, win)
	for _, want := range []string{"node.token", "--token-file", "SetAccessRuleProtection($true, $false)", "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators", "--service-name"} {
		if !strings.Contains(win, want) {
			t.Fatalf("windows script missing %q:\n%s", want, win)
		}
	}
	assertLeavesLegacyInstall(t, win)

	for _, withCA := range []bool{true, false} {
		if !withCA {
			c.CAFile = ""
		}
		dk, err := c.enrollDockerScript(testNodeID, "umbra_boot_abc")
		if err != nil {
			t.Fatal(err)
		}
		assertTokenNotOnCommandLine(t, dk)
		for _, want := range []string{"umask 077", `printf '%s' 'umbra_boot_abc' >"$HOME/.umbra/nde-abc/node.token"`, `-v "$HOME/.umbra/nde-abc/node.token":/etc/umbra/node.token:ro`, "--token-file /etc/umbra/node.token"} {
			if !strings.Contains(dk, want) {
				t.Fatalf("docker script (ca=%v) missing %q:\n%s", withCA, want, dk)
			}
		}
		assertLeavesLegacyInstall(t, dk)
	}
}

func TestEnrollTokenVisibility(t *testing.T) {
	c, _, _ := newTestConsole(t)
	for _, hide := range []bool{false, true} {
		c.HideNodeToken = hide
		for _, platform := range []string{"linux", "darwin", "windows", "docker"} {
			cmd, err := c.enrollBinScript(testNodeID, "umbra_boot_test", platform, "amd64")
			if err != nil {
				t.Fatal(err)
			}
			if platform == "docker" {
				cmd, err = c.enrollDockerScript(testNodeID, "umbra_boot_test")
				if err != nil {
					t.Fatal(err)
				}
			}
			if hide {
				assertTokenNotOnCommandLine(t, cmd)
			} else if !strings.Contains(cmd, "--token ") {
				t.Fatalf("%s: default script must pass token in argv", platform)
			}
			assertLeavesLegacyInstall(t, cmd)
		}
		fields, err := c.enrollFields(testNodeID, "umbra_boot_test", "linux", "amd64")
		if err != nil {
			t.Fatal(err)
		}
		if fields["hideNodeToken"] != hide {
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
