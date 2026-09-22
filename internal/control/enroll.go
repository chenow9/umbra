package control

import (
	"fmt"
	"os"
	"strings"
)

const nodeDockerImage = "chenow9/umbra-node:latest"

func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

func (c *Console) enrollServer() string {
	if c.Listen != "" {
		return c.Listen
	}
	return "入口:4400"
}

func (c *Console) caPEM() string {
	if c.CAFile == "" {
		return ""
	}
	b, err := os.ReadFile(c.CAFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func writeHeredoc(b *strings.Builder, pem string) {
	b.WriteString(pem)
	if !strings.HasSuffix(pem, "\n") {
		b.WriteByte('\n')
	}
	b.WriteString("UMBRA_CA\n")
}

func psQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

func nodePlatform(platform, arch string) (string, string) {
	switch platform {
	case "darwin", "windows":
	default:
		platform = "linux"
	}
	if arch != "arm64" {
		arch = "amd64"
	}
	return platform, arch
}

func nodeBinaryName(platform, arch string) string {
	platform, arch = nodePlatform(platform, arch)
	ext := ""
	if platform == "windows" {
		ext = ".exe"
	}
	return "umbra-node_" + platform + "_" + arch + ext
}

func writeUnixCAInstall(b *strings.Builder, pem, dir string) {
	if pem == "" {
		fmt.Fprintf(b, "sudo install -m 600 ./ca.crt %s/ca.crt\n", dir)
		return
	}
	fmt.Fprintf(b, "sudo tee %s/ca.crt >/dev/null <<'UMBRA_CA'\n", dir)
	writeHeredoc(b, pem)
	fmt.Fprintf(b, "sudo chmod 600 %s/ca.crt\n", dir)
}

// nodeInstanceKey maps a node id to the suffix used in service names and paths.
// Keep it identical to nodeInstanceKey in src/lib/umbra/units.ts.
func nodeInstanceKey(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" || len(id) > 80 {
		return "", fmt.Errorf("invalid node id")
	}
	b := make([]byte, 0, len(id))
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
			b = append(b, c)
		case c >= 'A' && c <= 'Z':
			b = append(b, c-'A'+'a')
		case c == '_', c == '-':
			b = append(b, '-')
		default:
			return "", fmt.Errorf("invalid node id")
		}
	}
	if len(b) == 0 || b[0] == '-' || b[len(b)-1] == '-' {
		return "", fmt.Errorf("invalid node id")
	}
	return string(b), nil
}

type nodePaths struct {
	key       string
	unit      string
	label     string
	container string
	winSvc    string
	linuxDir  string
	darwinDir string
	runner    string
	plist     string
}

func nodePathsFor(id string) (nodePaths, error) {
	key, err := nodeInstanceKey(id)
	if err != nil {
		return nodePaths{}, err
	}
	return nodePaths{
		key:       key,
		unit:      "umbra-node-" + key,
		label:     "io.umbra.node." + key,
		container: "umbra-node-" + key,
		winSvc:    "UmbraNode-" + key,
		linuxDir:  "/etc/umbra/nodes/" + key,
		darwinDir: "/usr/local/etc/umbra/nodes/" + key,
		runner:    "/usr/local/libexec/umbra-node-" + key,
		plist:     "/Library/LaunchDaemons/io.umbra.node." + key + ".plist",
	}, nil
}

const nodeInstanceComment = "# 本命令只安装或替换当前节点，不会停止这台机器上的其他节点。\n" +
	"# 若还留着旧的固定名服务（umbra-node、io.umbra.node、UmbraNode 或容器 umbra-node），新服务起来后请手动停掉那一份。\n"

func (c *Console) enrollLinuxScript(nodeID, token, arch string) (string, error) {
	p, err := nodePathsFor(nodeID)
	if err != nil {
		return "", err
	}
	server := shQuote(c.enrollServer())
	tok := shQuote(token)
	pem := c.caPEM()
	var b strings.Builder
	bin := nodeBinaryName("linux", arch)
	fmt.Fprintf(&b, "# 在当前目录放置 %s 后执行。\n", bin)
	if pem != "" {
		b.WriteString("# 入口 CA 已包含在命令中，不必再下载或 scp。\n")
	}
	b.WriteString(nodeInstanceComment)
	b.WriteString("set -eu\n")
	fmt.Fprintf(&b, "sudo install -m 755 %s /usr/local/bin/umbra-node\n", shQuote("./"+bin))
	fmt.Fprintf(&b, "sudo install -d -m 700 %s\n", p.linuxDir)
	writeUnixCAInstall(&b, pem, p.linuxDir)
	fmt.Fprintf(&b, "printf 'UMBRA_SERVER=%%s\\nUMBRA_TOKEN=%%s\\n' %s %s | sudo tee %s/node.env >/dev/null\n", server, tok, p.linuxDir)
	fmt.Fprintf(&b, "sudo chmod 600 %s/node.env\n", p.linuxDir)
	fmt.Fprintf(&b, "sudo tee /etc/systemd/system/%s.service >/dev/null <<'UMBRA_SERVICE'\n", p.unit)
	fmt.Fprintf(&b, `[Unit]
Description=Umbra Node (%s)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%s/node.env
ExecStart=/usr/local/bin/umbra-node --server ${UMBRA_SERVER} --tls-ca %s/ca.crt`, p.key, p.linuxDir, p.linuxDir)
	if !c.HideNodeToken {
		b.WriteString(" --token ${UMBRA_TOKEN}")
	}
	fmt.Fprintf(&b, `
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UMBRA_SERVICE
sudo systemctl daemon-reload
sudo systemctl enable %s >/dev/null
sudo systemctl restart %s
sudo systemctl --no-pager --full status %s
`, p.unit, p.unit, p.unit)
	return b.String(), nil
}

func (c *Console) enrollDarwinScript(nodeID, token, arch string) (string, error) {
	p, err := nodePathsFor(nodeID)
	if err != nil {
		return "", err
	}
	server := shQuote(c.enrollServer())
	tok := shQuote(token)
	pem := c.caPEM()
	bin := nodeBinaryName("darwin", arch)
	var b strings.Builder
	fmt.Fprintf(&b, "# 在当前目录放置 %s 后执行。\n", bin)
	if pem != "" {
		b.WriteString("# 入口 CA 已包含在命令中，不必再下载或 scp。\n")
	}
	b.WriteString(nodeInstanceComment)
	b.WriteString("set -eu\n")
	b.WriteString("sudo install -d -m 755 /usr/local/bin /usr/local/libexec\n")
	fmt.Fprintf(&b, "sudo install -m 755 %s /usr/local/bin/umbra-node\n", shQuote("./"+bin))
	fmt.Fprintf(&b, "sudo install -d -m 700 %s\n", p.darwinDir)
	writeUnixCAInstall(&b, pem, p.darwinDir)
	fmt.Fprintf(&b, "printf '%%s' %s | sudo tee %s/server >/dev/null\n", server, p.darwinDir)
	fmt.Fprintf(&b, "printf '%%s' %s | sudo tee %s/node.token >/dev/null\n", tok, p.darwinDir)
	fmt.Fprintf(&b, "sudo chmod 600 %s/server %s/node.token\n", p.darwinDir, p.darwinDir)
	fmt.Fprintf(&b, "sudo tee %s >/dev/null <<'UMBRA_RUNNER'\n", p.runner)
	fmt.Fprintf(&b, `#!/bin/sh
set -eu
UMBRA_TOKEN="$(cat %s/node.token)"
export UMBRA_TOKEN
exec /usr/local/bin/umbra-node \
  --server "$(cat %s/server)" \
  --tls-ca %s/ca.crt`, p.darwinDir, p.darwinDir, p.darwinDir)
	if !c.HideNodeToken {
		b.WriteString(` --token "$UMBRA_TOKEN"`)
	}
	fmt.Fprintf(&b, `
UMBRA_RUNNER
sudo chmod 755 %s
sudo tee %s >/dev/null <<'UMBRA_PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>2</integer>
</dict>
</plist>
UMBRA_PLIST
sudo chown root:wheel %s
sudo chmod 644 %s
sudo launchctl bootout system/%s >/dev/null 2>&1 || true
sudo launchctl bootstrap system %s
sudo launchctl enable system/%s
sudo launchctl kickstart -k system/%s
sudo launchctl print system/%s
`, p.runner, p.plist, p.label, p.runner, p.plist, p.plist, p.label, p.plist, p.label, p.label, p.label)
	return b.String(), nil
}

func (c *Console) enrollWindowsScript(nodeID, token, arch string) (string, error) {
	p, err := nodePathsFor(nodeID)
	if err != nil {
		return "", err
	}
	server := psQuote(c.enrollServer())
	tok := psQuote(token)
	pem := c.caPEM()
	bin := nodeBinaryName("windows", arch)
	var b strings.Builder
	b.WriteString("# 请在管理员 PowerShell 中执行。\n")
	if pem != "" {
		b.WriteString("# 入口 CA 已包含在命令中，不必再下载或 scp。\n")
	}
	b.WriteString(nodeInstanceComment)
	b.WriteString("$ErrorActionPreference = 'Stop'\n")
	b.WriteString("$identity = [Security.Principal.WindowsIdentity]::GetCurrent()\n")
	b.WriteString("$principal = New-Object Security.Principal.WindowsPrincipal($identity)\n")
	b.WriteString("if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {\n")
	b.WriteString("  throw '请以管理员身份运行 PowerShell 后重新执行。'\n")
	b.WriteString("}\n")
	b.WriteString("$root = Join-Path $env:ProgramData 'Umbra'\n")
	b.WriteString("$app = Join-Path $env:ProgramFiles 'Umbra'\n")
	fmt.Fprintf(&b, "$data = Join-Path (Join-Path $root 'nodes') '%s'\n", p.key)
	fmt.Fprintf(&b, "$serviceName = '%s'\n", p.winSvc)
	b.WriteString("New-Item -ItemType Directory -Force $data, $app | Out-Null\n")
	b.WriteString("$ca = Join-Path $data 'ca.crt'\n")
	if pem == "" {
		b.WriteString("Copy-Item -Force '.\\ca.crt' $ca\n")
	} else {
		b.WriteString("@'\n")
		b.WriteString(pem)
		b.WriteString("\n'@ | Set-Content -LiteralPath $ca -Encoding ascii\n")
	}
	b.WriteString("$exe = Join-Path $app 'umbra-node.exe'\n")
	b.WriteString("$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue\n")
	b.WriteString("if ($service -and $service.Status -ne 'Stopped') {\n")
	b.WriteString("  Stop-Service -Name $serviceName -Force\n")
	b.WriteString("  $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))\n")
	b.WriteString("}\n")
	b.WriteString("if ($service) {\n")
	b.WriteString("  $service.Dispose()\n")
	b.WriteString("  sc.exe delete $serviceName | Out-Null\n")
	b.WriteString("  if ($LASTEXITCODE -ne 0) { throw \"删除旧服务失败，sc.exe 退出码 $LASTEXITCODE\" }\n")
	b.WriteString("  for ($i = 0; $i -lt 50 -and (Get-Service -Name $serviceName -ErrorAction SilentlyContinue); $i++) {\n")
	b.WriteString("    Start-Sleep -Milliseconds 200\n")
	b.WriteString("  }\n")
	b.WriteString("  if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {\n")
	b.WriteString("    throw '旧服务仍在等待删除，请稍后重新执行。'\n")
	b.WriteString("  }\n")
	b.WriteString("}\n")
	// Another node may be running the shared binary. Keep going when the
	// file is locked and the destination already exists.
	fmt.Fprintf(&b, "$source = %s\n", psQuote(`.\\`+bin))
	b.WriteString("try {\n")
	b.WriteString("  Copy-Item -Force -LiteralPath $source -Destination $exe\n")
	b.WriteString("} catch {\n")
	b.WriteString("  if (-not (Test-Path -LiteralPath $exe)) { throw }\n")
	b.WriteString("  Write-Warning '另一个节点正在使用 umbra-node.exe，已保留现有程序。'\n")
	b.WriteString("}\n")
	if c.HideNodeToken {
		// The credential lives in a file readable only by SYSTEM and
		// Administrators and is passed by path. Anything in the service
		// command line is readable by every local user via sc qc.
		b.WriteString("$tokenFile = Join-Path $data 'node.token'\n")
		fmt.Fprintf(&b, "Set-Content -LiteralPath $tokenFile -Value %s -NoNewline -Encoding ascii\n", tok)
		b.WriteString("$acl = Get-Acl -LiteralPath $tokenFile\n")
		b.WriteString("$acl.SetAccessRuleProtection($true, $false)\n")
		b.WriteString("foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }\n")
		b.WriteString("foreach ($id in 'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators') {\n")
		b.WriteString("  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id, 'FullControl', 'Allow')))\n")
		b.WriteString("}\n")
		b.WriteString("Set-Acl -LiteralPath $tokenFile -AclObject $acl\n")
		fmt.Fprintf(&b, "$arguments = '--server ' + %s + ' --tls-ca \"' + $ca + '\" --token-file \"' + $tokenFile + '\" --service-name ' + $serviceName\n", server)
	} else {
		fmt.Fprintf(&b, "$arguments = '--server ' + %s + ' --tls-ca \"' + $ca + '\" --token ' + %s + ' --service-name ' + $serviceName\n", server, tok)
	}
	b.WriteString("$binPath = '\"' + $exe + '\" ' + $arguments\n")
	b.WriteString("Unblock-File -LiteralPath $exe -ErrorAction SilentlyContinue\n")
	b.WriteString("New-Service -Name $serviceName -BinaryPathName $binPath -DisplayName ('Umbra Node ' + $serviceName) -Description ('Umbra Node ' + $serviceName) -StartupType Automatic | Out-Null\n")
	b.WriteString("sc.exe failure $serviceName reset= 86400 actions= restart/2000/restart/5000/restart/10000 | Out-Null\n")
	b.WriteString("if ($LASTEXITCODE -ne 0) { throw \"设置服务恢复策略失败，sc.exe 退出码 $LASTEXITCODE\" }\n")
	b.WriteString("Start-Service -Name $serviceName\n")
	b.WriteString("$service = Get-Service -Name $serviceName\n")
	b.WriteString("$service.WaitForStatus('Running', [TimeSpan]::FromSeconds(15))\n")
	b.WriteString("$service\n")
	return b.String(), nil
}

func (c *Console) enrollBinScript(nodeID, token, platform, arch string) (string, error) {
	platform, arch = nodePlatform(platform, arch)
	switch platform {
	case "darwin":
		return c.enrollDarwinScript(nodeID, token, arch)
	case "windows":
		return c.enrollWindowsScript(nodeID, token, arch)
	default:
		return c.enrollLinuxScript(nodeID, token, arch)
	}
}

func (c *Console) enrollDockerScript(nodeID, token string) (string, error) {
	p, err := nodePathsFor(nodeID)
	if err != nil {
		return "", err
	}
	server := shQuote(c.enrollServer())
	tok := shQuote(token)
	pem := c.caPEM()
	var b strings.Builder
	// When hidden, the credential is written to a 0600 file and bind-mounted rather
	// than passed as a container argument or environment variable, both
	// of which are visible through docker inspect and the host's ps.
	if pem == "" {
		b.WriteString("# --network host 让映射目标 127.0.0.1 指向这台机器。\n")
		b.WriteString("# 把入口 ca.crt 放到当前目录后执行：\n")
		b.WriteString(nodeInstanceComment)
		b.WriteString("umask 077\n")
		fmt.Fprintf(&b, "mkdir -p \"$HOME/.umbra/%s\"\n", p.key)
		c.writeNodeDockerRun(&b, p, server, tok, `"$PWD/ca.crt"`)
		return b.String(), nil
	}
	b.WriteString("# 入口 CA 已包含在命令中，不必再下载或 scp。\n")
	b.WriteString("# --network host 让映射目标 127.0.0.1 指向这台机器。\n")
	b.WriteString(nodeInstanceComment)
	b.WriteString("umask 077\n")
	fmt.Fprintf(&b, "mkdir -p \"$HOME/.umbra/%s\"\n", p.key)
	fmt.Fprintf(&b, "if [ -d \"$HOME/.umbra/%s/ca.crt\" ]; then rm -rf \"$HOME/.umbra/%s/ca.crt\"; fi\n", p.key, p.key)
	fmt.Fprintf(&b, "cat >\"$HOME/.umbra/%s/ca.crt\" <<'UMBRA_CA'\n", p.key)
	writeHeredoc(&b, pem)
	c.writeNodeDockerRun(&b, p, server, tok, fmt.Sprintf(`"$HOME/.umbra/%s/ca.crt"`, p.key))
	return b.String(), nil
}

func (c *Console) writeNodeDockerRun(b *strings.Builder, p nodePaths, server, tok, caVolume string) {
	if c.HideNodeToken {
		fmt.Fprintf(b, "if [ -d \"$HOME/.umbra/%s/node.token\" ]; then rm -rf \"$HOME/.umbra/%s/node.token\"; fi\n", p.key, p.key)
		fmt.Fprintf(b, "printf '%%s' %s >\"$HOME/.umbra/%s/node.token\"\n", tok, p.key)
	}
	fmt.Fprintf(b, "docker rm -f %s >/dev/null 2>&1 || true\n", p.container)
	fmt.Fprintf(b, "docker run -d --name %s --network host --restart unless-stopped \\\n", p.container)
	fmt.Fprintf(b, "  -v %s:/etc/umbra/ca.crt:ro \\\n", caVolume)
	if c.HideNodeToken {
		fmt.Fprintf(b, "  -v \"$HOME/.umbra/%s/node.token\":/etc/umbra/node.token:ro \\\n", p.key)
	}
	fmt.Fprintf(b, "  %s \\\n", nodeDockerImage)
	if c.HideNodeToken {
		fmt.Fprintf(b, "  --server %s --tls-ca /etc/umbra/ca.crt --token-file /etc/umbra/node.token\n", server)
	} else {
		fmt.Fprintf(b, "  --server %s --tls-ca /etc/umbra/ca.crt --token %s\n", server, tok)
	}
}

func (c *Console) enrollFields(nodeID, token, platform, arch string) (map[string]any, error) {
	install, err := c.enrollBinScript(nodeID, token, platform, arch)
	if err != nil {
		return nil, err
	}
	docker, err := c.enrollDockerScript(nodeID, token)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"installCmd":    install,
		"dockerCmd":     docker,
		"listen":        c.Listen,
		"caURL":         "/v1/ca",
		"caPem":         c.caPEM(),
		"hideNodeToken": c.HideNodeToken,
	}, nil
}
