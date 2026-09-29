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

// nodeInstanceKey maps a node id to the suffix used in service names and paths.
// Keep it identical to nodeInstanceKey in internal/control/enroll.go.
export function nodeInstanceKey(nodeID: string): string {
  const raw = nodeID.trim();
  if (raw.length === 0 || raw.length > 80) throw new Error("invalid node id");
  let key = "";
  for (const c of raw) {
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) key += c;
    else if (c >= "A" && c <= "Z") key += c.toLowerCase();
    else if (c === "_" || c === "-") key += "-";
    else throw new Error("invalid node id");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(key)) throw new Error("invalid node id");
  return key;
}

function nodeInstallNames(nodeID: string) {
  const key = nodeInstanceKey(nodeID);
  return {
    key,
    unit: `umbra-node-${key}`,
    label: `io.umbra.node.${key}`,
    container: `umbra-node-${key}`,
    winService: `UmbraNode-${key}`,
    linuxDir: `/etc/umbra/nodes/${key}`,
    darwinDir: `/usr/local/etc/umbra/nodes/${key}`,
    runner: `/usr/local/libexec/umbra-node-${key}`,
    plist: `/Library/LaunchDaemons/io.umbra.node.${key}.plist`,
    dockerDir: `$HOME/.umbra/${key}`,
  };
}

const nodeInstanceComment =
  "# 本命令只安装或替换当前节点，不会停止这台机器上的其他节点。\n# 若还留着旧的固定名服务（umbra-node、io.umbra.node、UmbraNode 或容器 umbra-node），新服务起来后请手动停掉那一份。\n";

export function nodeEnrollLinuxCmd(
  nodeID: string,
  token: string,
  server: string | undefined,
  arch: Arch,
  caPem?: string,
  hideNodeToken = false,
) {
  const names = nodeInstallNames(nodeID);
  const srv = shSingleQuote(enrollServer(server));
  const tok = shSingleQuote(token);
  const bin = shSingleQuote(`./${binaryName("umbra-node", "linux", arch)}`);
  return `# 在当前目录放置 ${binaryName("umbra-node", "linux", arch)} 后执行。
${caPem?.trim() ? "# 入口 CA 已包含在命令中，不必再下载或 scp。\n" : ""}${nodeInstanceComment}set -eu
sudo install -m 755 ${bin} /usr/local/bin/umbra-node
sudo install -d -m 700 ${names.linuxDir}
${unixCAInstall(caPem, names.linuxDir)}
printf 'UMBRA_SERVER=%s\nUMBRA_TOKEN=%s\n' ${srv} ${tok} | sudo tee ${names.linuxDir}/node.env >/dev/null
sudo chmod 600 ${names.linuxDir}/node.env
sudo tee /etc/systemd/system/${names.unit}.service >/dev/null <<'UMBRA_SERVICE'
[Unit]
Description=Umbra Node (${names.key})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${names.linuxDir}/node.env
ExecStart=/usr/local/bin/umbra-node --server \${UMBRA_SERVER} --tls-ca ${names.linuxDir}/ca.crt${hideNodeToken ? "" : " --token ${UMBRA_TOKEN}"}
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UMBRA_SERVICE
sudo systemctl daemon-reload
sudo systemctl enable ${names.unit} >/dev/null
sudo systemctl restart ${names.unit}
sudo systemctl --no-pager --full status ${names.unit}
`;
}

export function nodeEnrollDarwinCmd(
  nodeID: string,
  token: string,
  server: string | undefined,
  arch: Arch,
  caPem?: string,
  hideNodeToken = false,
) {
  const names = nodeInstallNames(nodeID);
  const srv = shSingleQuote(enrollServer(server));
  const tok = shSingleQuote(token);
  const binName = binaryName("umbra-node", "darwin", arch);
  const bin = shSingleQuote(`./${binName}`);
  return `# 在当前目录放置 ${binName} 后执行。
${caPem?.trim() ? "# 入口 CA 已包含在命令中，不必再下载或 scp。\n" : ""}${nodeInstanceComment}set -eu
sudo install -d -m 755 /usr/local/bin /usr/local/libexec
sudo install -m 755 ${bin} /usr/local/bin/umbra-node
sudo install -d -m 700 ${names.darwinDir}
${unixCAInstall(caPem, names.darwinDir)}
printf '%s' ${srv} | sudo tee ${names.darwinDir}/server >/dev/null
printf '%s' ${tok} | sudo tee ${names.darwinDir}/node.token >/dev/null
sudo chmod 600 ${names.darwinDir}/server ${names.darwinDir}/node.token
sudo tee ${names.runner} >/dev/null <<'UMBRA_RUNNER'
#!/bin/sh
set -eu
UMBRA_TOKEN="$(cat ${names.darwinDir}/node.token)"
export UMBRA_TOKEN
exec /usr/local/bin/umbra-node \
  --server "$(cat ${names.darwinDir}/server)" \
  --tls-ca ${names.darwinDir}/ca.crt${hideNodeToken ? "" : ' --token "$UMBRA_TOKEN"'}
UMBRA_RUNNER
sudo chmod 755 ${names.runner}
sudo tee ${names.plist} >/dev/null <<'UMBRA_PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${names.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${names.runner}</string>
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
sudo chown root:wheel ${names.plist}
sudo chmod 644 ${names.plist}
sudo launchctl bootout system/${names.label} >/dev/null 2>&1 || true
sudo launchctl bootstrap system ${names.plist}
sudo launchctl enable system/${names.label}
sudo launchctl kickstart -k system/${names.label}
sudo launchctl print system/${names.label}
`;
}

export function nodeEnrollServiceCmd(
  platform: Exclude<Platform, "docker">,
  arch: Arch,
  nodeID: string,
  token: string,
  server?: string,
  caPem?: string,
  hideNodeToken = false,
) {
  if (platform === "windows") {
    return nodeEnrollWindowsCmd(nodeID, token, server, arch, caPem, hideNodeToken);
  }
  if (platform === "darwin") {
    return nodeEnrollDarwinCmd(nodeID, token, server, arch, caPem, hideNodeToken);
  }
  return nodeEnrollLinuxCmd(nodeID, token, server, arch, caPem, hideNodeToken);
}

// Callers without platform metadata receive the Linux systemd command.
export function nodeEnrollBinCmd(
  nodeID: string,
  token: string,
  server?: string,
  caPem?: string,
  hideNodeToken = false,
) {
  return nodeEnrollLinuxCmd(nodeID, token, server, "amd64", caPem, hideNodeToken);
}

function nodeDockerRun(
  names: ReturnType<typeof nodeInstallNames>,
  server: string,
  token: string,
  caVolume: string,
  hideNodeToken: boolean,
) {
  const tok = shSingleQuote(token);
  // When hidden, the credential is written to a 0600 file and bind-mounted rather than
  // passed as a container argument or environment variable, both of which
  // are visible through docker inspect and the host's ps.
  const writeToken = hideNodeToken
    ? `if [ -d "${names.dockerDir}/node.token" ]; then rm -rf "${names.dockerDir}/node.token"; fi
printf '%s' ${tok} >"${names.dockerDir}/node.token"
`
    : "";
  return `${writeToken}docker rm -f ${names.container} >/dev/null 2>&1 || true
docker run -d --name ${names.container} --network host --restart unless-stopped \\
  -v ${caVolume}:/etc/umbra/ca.crt:ro \\
${hideNodeToken ? `  -v "${names.dockerDir}/node.token":/etc/umbra/node.token:ro \\\n` : ""}  ${DOCKERHUB_NODE}:latest \\
  --server ${server} --tls-ca /etc/umbra/ca.crt ${hideNodeToken ? "--token-file /etc/umbra/node.token" : `--token ${tok}`}
`;
}

export function nodeEnrollDockerCmd(
  nodeID: string,
  token: string,
  server?: string,
  caPem?: string,
  hideNodeToken = false,
) {
  const names = nodeInstallNames(nodeID);
  const srv = shSingleQuote(enrollServer(server));
  const pem = caPem?.trim();
  const head = `# --network host 让映射目标 127.0.0.1 指向这台机器。`;
  if (!pem) {
    return `${head}
# 把入口 ca.crt 放到当前目录后执行：
${nodeInstanceComment}umask 077
mkdir -p "${names.dockerDir}"
${nodeDockerRun(names, srv, token, '"$PWD/ca.crt"', hideNodeToken)}`;
  }
  return withCAHeredoc(
    pem,
    `# 入口 CA 已包含在命令中，不必再下载或 scp。
${head}
${nodeInstanceComment}umask 077
mkdir -p "${names.dockerDir}"
if [ -d "${names.dockerDir}/ca.crt" ]; then rm -rf "${names.dockerDir}/ca.crt"; fi
cat >"${names.dockerDir}/ca.crt" <<'UMBRA_CA'`,
    nodeDockerRun(names, srv, token, `"${names.dockerDir}/ca.crt"`, hideNodeToken),
  );
}

export function nodeEnrollWindowsCmd(
  nodeID: string,
  token: string,
  server: string | undefined,
  arch: Arch,
  caPem?: string,
  hideNodeToken = false,
) {
  const names = nodeInstallNames(nodeID);
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
${pem ? "# 入口 CA 已包含在命令中，不必再下载或 scp。\n" : ""}${nodeInstanceComment}$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请以管理员身份运行 PowerShell 后重新执行。'
}
$root = Join-Path $env:ProgramData 'Umbra'
$app = Join-Path $env:ProgramFiles 'Umbra'
$data = Join-Path (Join-Path $root 'nodes') '${names.key}'
$serviceName = '${names.winService}'
New-Item -ItemType Directory -Force $data, $app | Out-Null
$ca = Join-Path $data 'ca.crt'
${writeCA}
$exe = Join-Path $app 'umbra-node.exe'
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne 'Stopped') {
  Stop-Service -Name $serviceName -Force
  $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
}
if ($service) {
  $service.Dispose()
  sc.exe delete $serviceName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "删除旧服务失败，sc.exe 退出码 $LASTEXITCODE" }
  for ($i = 0; $i -lt 50 -and (Get-Service -Name $serviceName -ErrorAction SilentlyContinue); $i++) {
    Start-Sleep -Milliseconds 200
  }
  if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
    throw '旧服务仍在等待删除，请稍后重新执行。'
  }
}
$source = ${bin}
try {
  Copy-Item -Force -LiteralPath $source -Destination $exe
} catch {
  if (-not (Test-Path -LiteralPath $exe)) { throw }
  Write-Warning '另一个节点正在使用 umbra-node.exe，已保留现有程序。'
}
${
  hideNodeToken
    ? `$tokenFile = Join-Path $data 'node.token'
Set-Content -LiteralPath $tokenFile -Value ${tok} -NoNewline -Encoding ascii
$acl = Get-Acl -LiteralPath $tokenFile
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }
foreach ($id in 'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators') {
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id, 'FullControl', 'Allow')))
}
Set-Acl -LiteralPath $tokenFile -AclObject $acl
$arguments = '--server ' + ${srv} + ' --tls-ca "' + $ca + '" --token-file "' + $tokenFile + '" --service-name ' + $serviceName`
    : `$arguments = '--server ' + ${srv} + ' --tls-ca "' + $ca + '" --token ' + ${tok} + ' --service-name ' + $serviceName`
}
$binPath = '"' + $exe + '" ' + $arguments
Unblock-File -LiteralPath $exe -ErrorAction SilentlyContinue
New-Service -Name $serviceName -BinaryPathName $binPath -DisplayName ('Umbra Node ' + $serviceName) -Description ('Umbra Node ' + $serviceName) -StartupType Automatic | Out-Null
sc.exe failure $serviceName reset= 86400 actions= restart/2000/restart/5000/restart/10000 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "设置服务恢复策略失败，sc.exe 退出码 $LASTEXITCODE" }
Start-Service -Name $serviceName
$service = Get-Service -Name $serviceName
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

/** Run a downloaded visitor binary and CA from the same directory, on any host OS. */
export function portableVisitorCommand(command: string, platform: Platform, arch: Arch): string {
  const binary = binaryName("umbra-visit", platform, arch);
  const executable = platform === "windows" ? `.\\${binary}` : `./${binary}`;
  const run = command
    .replace(/^umbra-visit(?=\s)/, () => executable)
    .replace(/--tls-ca \/etc\/umbra\/ca\.crt(?=\s|$)/, "--tls-ca ./ca.crt");
  return platform === "windows" ? run : `chmod +x ./${binary}\n${run}`;
}
