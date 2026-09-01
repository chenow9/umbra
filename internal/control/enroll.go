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

func (c *Console) enrollLinuxScript(token, arch string) string {
	server := shQuote(c.enrollServer())
	tok := shQuote(token)
	pem := c.caPEM()
	var b strings.Builder
	bin := nodeBinaryName("linux", arch)
	fmt.Fprintf(&b, "# 在当前目录放置 %s 后执行。\n", bin)
	if pem != "" {
		b.WriteString("# 入口 CA 已包含在命令中，不必再下载或 scp。\n")
	}
	b.WriteString("set -eu\n")
	fmt.Fprintf(&b, "sudo install -m 755 %s /usr/local/bin/umbra-node\n", shQuote("./"+bin))
	b.WriteString("sudo install -d -m 700 /etc/umbra\n")
	writeUnixCAInstall(&b, pem, "/etc/umbra")
	fmt.Fprintf(&b, "printf 'UMBRA_SERVER=%%s\\nUMBRA_TOKEN=%%s\\n' %s %s | sudo tee /etc/umbra/node.env >/dev/null\n", server, tok)
	b.WriteString("sudo chmod 600 /etc/umbra/node.env\n")
	b.WriteString("sudo tee /etc/systemd/system/umbra-node.service >/dev/null <<'UMBRA_SERVICE'\n")
	b.WriteString(`[Unit]
Description=Umbra Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/umbra/node.env
ExecStart=/usr/local/bin/umbra-node --server ${UMBRA_SERVER} --tls-ca /etc/umbra/ca.crt
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UMBRA_SERVICE
sudo systemctl daemon-reload
sudo systemctl enable umbra-node >/dev/null
sudo systemctl restart umbra-node
sudo systemctl --no-pager --full status umbra-node
`)
	return b.String()
}

func (c *Console) enrollDarwinScript(token, arch string) string {
	server := shQuote(c.enrollServer())
	tok := shQuote(token)
	pem := c.caPEM()
	bin := nodeBinaryName("darwin", arch)
	var b strings.Builder
	fmt.Fprintf(&b, "# 在当前目录放置 %s 后执行。\n", bin)
	if pem != "" {
		b.WriteString("# 入口 CA 已包含在命令中，不必再下载或 scp。\n")
	}
	b.WriteString("set -eu\n")
	b.WriteString("sudo install -d -m 755 /usr/local/bin /usr/local/libexec\n")
	fmt.Fprintf(&b, "sudo install -m 755 %s /usr/local/bin/umbra-node\n", shQuote("./"+bin))
	b.WriteString("sudo install -d -m 700 /usr/local/etc/umbra\n")
	writeUnixCAInstall(&b, pem, "/usr/local/etc/umbra")
	fmt.Fprintf(&b, "printf '%%s' %s | sudo tee /usr/local/etc/umbra/server >/dev/null\n", server)
	fmt.Fprintf(&b, "printf '%%s' %s | sudo tee /usr/local/etc/umbra/node.token >/dev/null\n", tok)
	b.WriteString("sudo chmod 600 /usr/local/etc/umbra/server /usr/local/etc/umbra/node.token\n")
	b.WriteString("sudo tee /usr/local/libexec/umbra-node-run >/dev/null <<'UMBRA_RUNNER'\n")
	b.WriteString(`#!/bin/sh
set -eu
UMBRA_TOKEN="$(cat /usr/local/etc/umbra/node.token)"
export UMBRA_TOKEN
exec /usr/local/bin/umbra-node \
  --server "$(cat /usr/local/etc/umbra/server)" \
  --tls-ca /usr/local/etc/umbra/ca.crt
UMBRA_RUNNER
sudo chmod 755 /usr/local/libexec/umbra-node-run
sudo tee /Library/LaunchDaemons/io.umbra.node.plist >/dev/null <<'UMBRA_PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.umbra.node</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/libexec/umbra-node-run</string>
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
sudo chown root:wheel /Library/LaunchDaemons/io.umbra.node.plist
sudo chmod 644 /Library/LaunchDaemons/io.umbra.node.plist
sudo launchctl bootout system/io.umbra.node >/dev/null 2>&1 || true
sudo launchctl bootstrap system /Library/LaunchDaemons/io.umbra.node.plist
sudo launchctl enable system/io.umbra.node
sudo launchctl kickstart -k system/io.umbra.node
sudo launchctl print system/io.umbra.node
`)
	return b.String()
}

func (c *Console) enrollWindowsScript(token, arch string) string {
	server := psQuote(c.enrollServer())
	tok := psQuote(token)
	pem := c.caPEM()
	bin := nodeBinaryName("windows", arch)
	var b strings.Builder
	b.WriteString("# 请在管理员 PowerShell 中执行。\n")
	if pem != "" {
		b.WriteString("# 入口 CA 已包含在命令中，不必再下载或 scp。\n")
	}
	b.WriteString("$ErrorActionPreference = 'Stop'\n")
	b.WriteString("$identity = [Security.Principal.WindowsIdentity]::GetCurrent()\n")
	b.WriteString("$principal = New-Object Security.Principal.WindowsPrincipal($identity)\n")
	b.WriteString("if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {\n")
	b.WriteString("  throw '请以管理员身份运行 PowerShell 后重新执行。'\n")
	b.WriteString("}\n")
	b.WriteString("$data = Join-Path $env:ProgramData 'Umbra'\n")
	b.WriteString("$app = Join-Path $env:ProgramFiles 'Umbra'\n")
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
	b.WriteString("$service = Get-Service -Name 'UmbraNode' -ErrorAction SilentlyContinue\n")
	b.WriteString("if ($service -and $service.Status -ne 'Stopped') {\n")
	b.WriteString("  Stop-Service -Name 'UmbraNode' -Force\n")
	b.WriteString("  $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))\n")
	b.WriteString("}\n")
	b.WriteString("if ($service) {\n")
	b.WriteString("  $service.Dispose()\n")
	b.WriteString("  sc.exe delete UmbraNode | Out-Null\n")
	b.WriteString("  if ($LASTEXITCODE -ne 0) { throw \"删除旧服务失败，sc.exe 退出码 $LASTEXITCODE\" }\n")
	b.WriteString("  for ($i = 0; $i -lt 50 -and (Get-Service -Name 'UmbraNode' -ErrorAction SilentlyContinue); $i++) {\n")
	b.WriteString("    Start-Sleep -Milliseconds 200\n")
	b.WriteString("  }\n")
	b.WriteString("  if (Get-Service -Name 'UmbraNode' -ErrorAction SilentlyContinue) {\n")
	b.WriteString("    throw '旧服务仍在等待删除，请稍后重新执行。'\n")
	b.WriteString("  }\n")
	b.WriteString("}\n")
	fmt.Fprintf(&b, "Copy-Item -Force %s $exe\n", psQuote(`.\`+bin))
	fmt.Fprintf(&b, "$arguments = '--server ' + %s + ' --tls-ca \"' + $ca + '\" --token ' + %s\n", server, tok)
	b.WriteString("$binPath = '\"' + $exe + '\" ' + $arguments\n")
	b.WriteString("Unblock-File -LiteralPath $exe -ErrorAction SilentlyContinue\n")
	b.WriteString("New-Service -Name 'UmbraNode' -BinaryPathName $binPath -DisplayName 'Umbra Node' -Description 'Umbra Node' -StartupType Automatic | Out-Null\n")
	b.WriteString("sc.exe failure UmbraNode reset= 86400 actions= restart/2000/restart/5000/restart/10000 | Out-Null\n")
	b.WriteString("if ($LASTEXITCODE -ne 0) { throw \"设置服务恢复策略失败，sc.exe 退出码 $LASTEXITCODE\" }\n")
	b.WriteString("Start-Service -Name 'UmbraNode'\n")
	b.WriteString("$service = Get-Service -Name 'UmbraNode'\n")
	b.WriteString("$service.WaitForStatus('Running', [TimeSpan]::FromSeconds(15))\n")
	b.WriteString("$service\n")
	return b.String()
}

func (c *Console) enrollBinScript(token, platform, arch string) string {
	platform, arch = nodePlatform(platform, arch)
	switch platform {
	case "darwin":
		return c.enrollDarwinScript(token, arch)
	case "windows":
		return c.enrollWindowsScript(token, arch)
	default:
		return c.enrollLinuxScript(token, arch)
	}
}

func (c *Console) enrollDockerScript(token string) string {
	server := shQuote(c.enrollServer())
	tok := shQuote(token)
	pem := c.caPEM()
	var b strings.Builder
	b.WriteString("# --network host 让映射目标 127.0.0.1 指向这台机器。\n")
	if pem == "" {
		b.WriteString("# 把入口 ca.crt 放到当前目录后执行：\n")
		b.WriteString("docker rm -f umbra-node >/dev/null 2>&1 || true\n")
		fmt.Fprintf(&b, "docker run -d --name umbra-node --network host --restart unless-stopped \\\n")
		fmt.Fprintf(&b, "  -v \"$PWD/ca.crt\":/etc/umbra/ca.crt:ro \\\n")
		fmt.Fprintf(&b, "  %s \\\n", nodeDockerImage)
		fmt.Fprintf(&b, "  --server %s --tls-ca /etc/umbra/ca.crt --token %s\n", server, tok)
		return b.String()
	}
	b.WriteString("# 入口 CA 已包含在命令中，不必再下载或 scp。\n")
	b.WriteString("umask 077\n")
	b.WriteString("mkdir -p \"$HOME/.umbra\"\n")
	b.WriteString("if [ -d \"$HOME/.umbra/ca.crt\" ]; then rm -rf \"$HOME/.umbra/ca.crt\"; fi\n")
	b.WriteString("cat >\"$HOME/.umbra/ca.crt\" <<'UMBRA_CA'\n")
	writeHeredoc(&b, pem)
	b.WriteString("docker rm -f umbra-node >/dev/null 2>&1 || true\n")
	fmt.Fprintf(&b, "docker run -d --name umbra-node --network host --restart unless-stopped \\\n")
	fmt.Fprintf(&b, "  -v \"$HOME/.umbra/ca.crt\":/etc/umbra/ca.crt:ro \\\n")
	fmt.Fprintf(&b, "  %s \\\n", nodeDockerImage)
	fmt.Fprintf(&b, "  --server %s --tls-ca /etc/umbra/ca.crt --token %s\n", server, tok)
	return b.String()
}

func (c *Console) enrollFields(token, platform, arch string) map[string]any {
	return map[string]any{
		"installCmd": c.enrollBinScript(token, platform, arch),
		"dockerCmd":  c.enrollDockerScript(token),
		"listen":     c.Listen,
		"caURL":      "/v1/ca",
		"caPem":      c.caPEM(),
	}
}
