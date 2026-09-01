export type Platform = "linux" | "darwin" | "windows" | "docker";
export type Arch = "amd64" | "arm64";

export const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "linux", label: "Linux" },
  { id: "darwin", label: "macOS" },
  { id: "windows", label: "Windows" },
  { id: "docker", label: "Docker" },
];

export const ARCHS: { id: Arch; label: string }[] = [
  { id: "amd64", label: "amd64" },
  { id: "arm64", label: "arm64" },
];

export const DOCKERHUB_GATE = "chenow9/umbrad";
export const DOCKERHUB_NODE = "chenow9/umbra-node";

const visitorTicket = "umbra_vis_…";
const visitorServer = "gate.example.com:4400";

export function platformLabel(os: string, arch: string) {
  const p = PLATFORMS.find((x) => x.id === os)?.label ?? os;
  return `${p} ${arch}`;
}

function goos(platform: Platform) {
  return platform === "docker" ? "linux" : platform;
}

export function binaryName(
  kind: "umbrad" | "umbra-node" | "umbra-visit",
  platform: Platform,
  arch: Arch,
) {
  const ext = goos(platform) === "windows" ? ".exe" : "";
  return `${kind}_${goos(platform)}_${arch}${ext}`;
}

export function visitorRunCommand(caPath = "/etc/umbra/ca.crt") {
  return `umbra-visit --server ${visitorServer} --tls-ca ${caPath} --ticket ${visitorTicket} --local 127.0.0.1:2222`;
}

export function visitorCompose(arch: Arch) {
  return `# umbra-visit 已包含在入口镜像中；这里覆盖入口程序，只运行访问端。
# 签发票据后替换 UMBRA_TICKET；TCP / UDP 都映射到本机 127.0.0.1:2222。
services:
  umbra-visit:
    image: ${DOCKERHUB_GATE}:\${UMBRA_TAG:-latest}
    platform: linux/${arch}
    entrypoint: ["/usr/local/bin/umbra-visit"]
    command:
      - --server
      - ${visitorServer}
      - --tls-ca
      - /etc/umbra/ca.crt
      - --ticket
      - \${UMBRA_TICKET}
      - --local
      - 0.0.0.0:2222
    ports:
      - "127.0.0.1:2222:2222/tcp"
      - "127.0.0.1:2222:2222/udp"
    volumes:
      - ./ca.crt:/etc/umbra/ca.crt:ro
    restart: unless-stopped
`;
}

export function visitorInstall(platform: Platform, arch: Arch) {
  const bin = binaryName("umbra-visit", platform, arch);
  if (platform === "docker") return visitorCompose(arch);
  if (platform === "linux") {
    return `sudo install -m 755 ${bin} /usr/local/bin/umbra-visit
sudo install -d -m 755 /etc/umbra
sudo install -m 644 ca.crt /etc/umbra/ca.crt

${visitorRunCommand()}
`;
  }
  if (platform === "darwin") {
    return `sudo install -m 755 ${bin} /usr/local/bin/umbra-visit
sudo install -d -m 755 /usr/local/etc/umbra
sudo install -m 644 ca.crt /usr/local/etc/umbra/ca.crt

${visitorRunCommand("/usr/local/etc/umbra/ca.crt")}
`;
  }
  return `mkdir "%ProgramFiles%\\Umbra"
copy ${bin} "%ProgramFiles%\\Umbra\\umbra-visit.exe"
mkdir "C:\\ProgramData\\umbra"
copy ca.crt "C:\\ProgramData\\umbra\\ca.crt"

"%ProgramFiles%\\Umbra\\umbra-visit.exe" --server ${visitorServer} --tls-ca C:\\ProgramData\\umbra\\ca.crt --ticket ${visitorTicket} --local 127.0.0.1:2222
`;
}

export function umbradUnit(advertise: string) {
  return `[Unit]
Description=Umbra Gate
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/umbrad -tls-dir /var/lib/umbra -listen :4400 -advertise ${advertise} -http 127.0.0.1:8080 -bind 0.0.0.0
ExecReload=/bin/kill -USR2 $MAINPID
Restart=on-failure
RestartSec=2
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`;
}

export function umbradPlist(advertise: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.umbra.gate</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/umbrad</string>
    <string>-tls-dir</string>
    <string>/usr/local/var/umbra</string>
    <string>-listen</string>
    <string>:4400</string>
    <string>-advertise</string>
    <string>${advertise}</string>
    <string>-http</string>
    <string>127.0.0.1:8080</string>
    <string>-bind</string>
    <string>0.0.0.0</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

export function umbradWin(arch: Arch, advertise: string) {
  const bin = binaryName("umbrad", "windows", arch);
  return `if not exist "%ProgramFiles%\\Umbra" mkdir "%ProgramFiles%\\Umbra"
copy /Y ${bin} "%ProgramFiles%\\Umbra\\umbrad.exe"
sc.exe create UmbraGate binPath= ""%ProgramFiles%\\Umbra\\umbrad.exe" -tls-dir C:\\ProgramData\\umbra -listen :4400 -advertise ${advertise} -http 127.0.0.1:8080 -bind 0.0.0.0" start= auto
sc.exe start UmbraGate
`;
}

export function umbradDocker(arch: Arch, advertise: string) {
  return `docker volume create umbra-tls >/dev/null
docker run -d --name umbrad --network host --restart unless-stopped \\
  --platform linux/${arch} --cap-add NET_ADMIN --cap-add NET_BIND_SERVICE \\
  -v umbra-tls:/var/lib/umbra \\
  ${DOCKERHUB_GATE}:latest \\
  -listen :4400 -advertise ${shSingleQuote(advertise)} -http 127.0.0.1:8080 -bind 0.0.0.0 -tls-dir /var/lib/umbra
`;
}

export function nodeUnit(token: string) {
  return `[Unit]
Description=Umbra node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/umbra-node --server gate:4400 --tls-ca /etc/umbra/ca.crt
Environment=UMBRA_TOKEN=${token}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

export function nodePlist(token: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.umbra.node</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/umbra-node</string>
    <string>--server</string>
    <string>gate:4400</string>
    <string>--tls-ca</string>
    <string>/etc/umbra/ca.crt</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>UMBRA_TOKEN</key>
    <string>${token}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

export function shSingleQuote(s: string) {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

function psSingleQuote(s: string) {
  return `'${s.replace(/'/g, "''")}'`;
}

function enrollServer(server?: string) {
  return server?.trim() || "入口:4400";
}

function withCAHeredoc(pem: string, bodyBefore: string, bodyAfter: string) {
  const text = pem.trim();
  return `${bodyBefore}
${text}
UMBRA_CA
${bodyAfter}`;
}

export function enrollCmd(token: string, server = "gate:4400") {
  return `umbra-node --server ${server} --tls-ca /etc/umbra/ca.crt --token ${token}`;
}

function unixCAInstall(caPem: string | undefined, directory: string) {
  const pem = caPem?.trim();
  if (!pem) {
    return `sudo install -m 600 ./ca.crt ${directory}/ca.crt`;
  }
  return `sudo tee ${directory}/ca.crt >/dev/null <<'UMBRA_CA'
${pem}
UMBRA_CA
sudo chmod 600 ${directory}/ca.crt`;
}

export function nodeEnrollLinuxCmd(
  token: string,
  server: string | undefined,
  arch: Arch,
  caPem?: string,
) {
  const srv = shSingleQuote(enrollServer(server));
  const tok = shSingleQuote(token);
  const bin = shSingleQuote(`./${binaryName("umbra-node", "linux", arch)}`);
  return `# 在当前目录放置 ${binaryName("umbra-node", "linux", arch)} 后执行。
${caPem?.trim() ? "# 入口 CA 已包含在命令中，不必再下载或 scp。\n" : ""}set -eu
sudo install -m 755 ${bin} /usr/local/bin/umbra-node
sudo install -d -m 700 /etc/umbra
${unixCAInstall(caPem, "/etc/umbra")}
printf 'UMBRA_SERVER=%s\nUMBRA_TOKEN=%s\n' ${srv} ${tok} | sudo tee /etc/umbra/node.env >/dev/null
sudo chmod 600 /etc/umbra/node.env
sudo tee /etc/systemd/system/umbra-node.service >/dev/null <<'UMBRA_SERVICE'
[Unit]
Description=Umbra Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/umbra/node.env
ExecStart=/usr/local/bin/umbra-node --server \${UMBRA_SERVER} --tls-ca /etc/umbra/ca.crt
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
`;
}

export function nodeEnrollDarwinCmd(
  token: string,
  server: string | undefined,
  arch: Arch,
  caPem?: string,
) {
  const srv = shSingleQuote(enrollServer(server));
  const tok = shSingleQuote(token);
  const binName = binaryName("umbra-node", "darwin", arch);
  const bin = shSingleQuote(`./${binName}`);
  return `# 在当前目录放置 ${binName} 后执行。
${caPem?.trim() ? "# 入口 CA 已包含在命令中，不必再下载或 scp。\n" : ""}set -eu
sudo install -d -m 755 /usr/local/bin /usr/local/libexec
sudo install -m 755 ${bin} /usr/local/bin/umbra-node
sudo install -d -m 700 /usr/local/etc/umbra
${unixCAInstall(caPem, "/usr/local/etc/umbra")}
printf '%s' ${srv} | sudo tee /usr/local/etc/umbra/server >/dev/null
printf '%s' ${tok} | sudo tee /usr/local/etc/umbra/node.token >/dev/null
sudo chmod 600 /usr/local/etc/umbra/server /usr/local/etc/umbra/node.token
sudo tee /usr/local/libexec/umbra-node-run >/dev/null <<'UMBRA_RUNNER'
#!/bin/sh
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
`;
}

export function nodeEnrollServiceCmd(
  platform: Exclude<Platform, "docker">,
  arch: Arch,
  token: string,
  server?: string,
  caPem?: string,
) {
  if (platform === "windows") {
    return nodeEnrollWindowsCmd(token, server, arch, caPem);
  }
  if (platform === "darwin") {
    return nodeEnrollDarwinCmd(token, server, arch, caPem);
  }
  return nodeEnrollLinuxCmd(token, server, arch, caPem);
}

// Legacy server-side callers without platform metadata receive the Linux
// systemd command. New callers should use nodeEnrollServiceCmd.
export function nodeEnrollBinCmd(token: string, server?: string, caPem?: string) {
  return nodeEnrollLinuxCmd(token, server, "amd64", caPem);
}

export function nodeEnrollDockerCmd(token: string, server?: string, caPem?: string) {
  const srv = shSingleQuote(enrollServer(server));
  const tok = shSingleQuote(token);
  const pem = caPem?.trim();
  const head = `# --network host 让映射目标 127.0.0.1 指向这台机器。`;
  const run = `docker rm -f umbra-node >/dev/null 2>&1 || true
docker run -d --name umbra-node --network host --restart unless-stopped \\
  -v "$HOME/.umbra/ca.crt":/etc/umbra/ca.crt:ro \\
  ${DOCKERHUB_NODE}:latest \\
  --server ${srv} --tls-ca /etc/umbra/ca.crt --token ${tok}
`;
  if (!pem) {
    return `${head}
# 把入口 ca.crt 放到当前目录后执行：
docker rm -f umbra-node >/dev/null 2>&1 || true
docker run -d --name umbra-node --network host --restart unless-stopped \\
  -v "$PWD/ca.crt":/etc/umbra/ca.crt:ro \\
  ${DOCKERHUB_NODE}:latest \\
  --server ${srv} --tls-ca /etc/umbra/ca.crt --token ${tok}
`;
  }
  return withCAHeredoc(
    pem,
    `# 入口 CA 已包含在命令中，不必再下载或 scp。
${head}
umask 077
mkdir -p "$HOME/.umbra"
if [ -d "$HOME/.umbra/ca.crt" ]; then rm -rf "$HOME/.umbra/ca.crt"; fi
cat >"$HOME/.umbra/ca.crt" <<'UMBRA_CA'`,
    run,
  );
}

export function nodeEnrollWindowsCmd(
  token: string,
  server: string | undefined,
  arch: Arch,
  caPem?: string,
) {
  const srv = psSingleQuote(enrollServer(server));
  const tok = psSingleQuote(token);
  const bin = psSingleQuote(`.\\${binaryName("umbra-node", "windows", arch)}`);
  const pem = caPem?.trim();
  const writeCA = pem
    ? `@'
${pem}
'@ | Set-Content -LiteralPath $ca -Encoding ascii`
    : `Copy-Item -Force '.\\ca.crt' $ca`;
  return `# 请在管理员 PowerShell 中执行。
${pem ? "# 入口 CA 已包含在命令中，不必再下载或 scp。\n" : ""}$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请以管理员身份运行 PowerShell 后重新执行。'
}
$data = Join-Path $env:ProgramData 'Umbra'
$app = Join-Path $env:ProgramFiles 'Umbra'
New-Item -ItemType Directory -Force $data, $app | Out-Null
$ca = Join-Path $data 'ca.crt'
${writeCA}
$exe = Join-Path $app 'umbra-node.exe'
$service = Get-Service -Name 'UmbraNode' -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne 'Stopped') {
  Stop-Service -Name 'UmbraNode' -Force
  $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
}
if ($service) {
  $service.Dispose()
  sc.exe delete UmbraNode | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "删除旧服务失败，sc.exe 退出码 $LASTEXITCODE" }
  for ($i = 0; $i -lt 50 -and (Get-Service -Name 'UmbraNode' -ErrorAction SilentlyContinue); $i++) {
    Start-Sleep -Milliseconds 200
  }
  if (Get-Service -Name 'UmbraNode' -ErrorAction SilentlyContinue) {
    throw '旧服务仍在等待删除，请稍后重新执行。'
  }
}
Copy-Item -Force ${bin} $exe
$arguments = '--server ' + ${srv} + ' --tls-ca "' + $ca + '" --token ' + ${tok}
$binPath = '"' + $exe + '" ' + $arguments
Unblock-File -LiteralPath $exe -ErrorAction SilentlyContinue
New-Service -Name 'UmbraNode' -BinaryPathName $binPath -DisplayName 'Umbra Node' -Description 'Umbra Node' -StartupType Automatic | Out-Null
sc.exe failure UmbraNode reset= 86400 actions= restart/2000/restart/5000/restart/10000 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "设置服务恢复策略失败，sc.exe 退出码 $LASTEXITCODE" }
Start-Service -Name 'UmbraNode'
$service = Get-Service -Name 'UmbraNode'
$service.WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
$service
`;
}

export function nodeWinService(token: string, arch: Arch = "amd64") {
  const bin = binaryName("umbra-node", "windows", arch);
  return `${enrollCmd(token)}

mkdir "%ProgramFiles%\\Umbra"
copy ${bin} "%ProgramFiles%\\Umbra\\umbra-node.exe"
sc.exe create UmbraNode binPath= "%ProgramFiles%\\Umbra\\umbra-node.exe --server gate:4400 --tls-ca C:\\ProgramData\\umbra\\ca.crt --token ${token}" start= auto
sc.exe start UmbraNode
`;
}

export function nodeCompose(token: string, arch: Arch) {
  return `services:
  umbra-node:
    image: ${DOCKERHUB_NODE}:\${UMBRA_TAG:-latest}
    platform: linux/${arch}
    network_mode: host
    environment:
      UMBRA_SERVER: gate.example.com:4400
      UMBRA_TOKEN: ${token}
      UMBRA_TLS_CA: /etc/umbra/ca.crt
    volumes:
      - ./ca.crt:/etc/umbra/ca.crt:ro
    restart: unless-stopped
`;
}

export function gateInstall(platform: Platform, arch: Arch, advertise: string) {
  if (!advertise.trim()) return "";
  const bin = binaryName("umbrad", platform, arch);
  if (platform === "docker") return umbradDocker(arch, advertise.trim());
  if (platform === "linux") {
    return `sudo install -m 755 ${bin} /usr/local/bin/umbrad
sudo install -d -m 700 /var/lib/umbra
sudo tee /etc/systemd/system/umbrad.service >/dev/null <<'UMBRA_SERVICE'
${umbradUnit(advertise.trim()).trim()}
UMBRA_SERVICE
sudo systemctl daemon-reload
sudo systemctl enable --now umbrad
`;
  }
  if (platform === "darwin") {
    return `sudo install -m 755 ${bin} /usr/local/bin/umbrad
sudo tee /Library/LaunchDaemons/io.umbra.gate.plist >/dev/null <<'UMBRA_PLIST'
${umbradPlist(advertise.trim()).trim()}
UMBRA_PLIST
sudo launchctl bootstrap system /Library/LaunchDaemons/io.umbra.gate.plist
`;
  }
  return umbradWin(arch, advertise.trim());
}

export function nodeInstall(platform: Platform, arch: Arch, token: string) {
  const bin = binaryName("umbra-node", platform, arch);
  if (platform === "docker") return nodeCompose(token, arch);
  if (platform === "linux") {
    return `${enrollCmd(token)}

install -m 755 ${bin} /usr/local/bin/umbra-node
sudo systemctl enable --now umbra-node

${nodeUnit(token).trim()}
`;
  }
  if (platform === "darwin") {
    return `${enrollCmd(token)}

install -m 755 ${bin} /usr/local/bin/umbra-node
sudo cp io.umbra.node.plist /Library/LaunchDaemons/
sudo launchctl load /Library/LaunchDaemons/io.umbra.node.plist

${nodePlist(token).trim()}
`;
  }
  return nodeWinService(token, arch);
}
