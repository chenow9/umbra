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

export function platformLabel(os: string, arch: string) {
  const p = PLATFORMS.find((x) => x.id === os)?.label ?? os;
  return `${p} ${arch}`;
}

function goos(platform: Platform) {
  return platform === "docker" ? "linux" : platform;
}

export function binaryName(kind: "umbrad" | "umbra-agent", platform: Platform, arch: Arch) {
  const ext = goos(platform) === "windows" ? ".exe" : "";
  return `${kind}_${goos(platform)}_${arch}${ext}`;
}

export const umbradUnit = `[Unit]
Description=Umbra Gate
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/umbrad -tls-dir /var/lib/umbra -listen :4400 -bind 0.0.0.0
ExecReload=/bin/kill -USR2 $MAINPID
Restart=on-failure
RestartSec=2
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`;

export const umbradPlist = `<?xml version="1.0" encoding="UTF-8"?>
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
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;

export function umbradWin(arch: Arch) {
  const bin = binaryName("umbrad", "windows", arch);
  return `mkdir "%ProgramFiles%\\Umbra"
copy ${bin} "%ProgramFiles%\\Umbra\\umbrad.exe"
sc.exe create UmbraGate binPath= "%ProgramFiles%\\Umbra\\umbrad.exe" start= auto
sc.exe start UmbraGate
`;
}

export function umbradCompose(arch: Arch) {
  return `# Linux 宿主机才能用 host 网络收入口端口。
# macOS / Windows 上的 Docker 没有真正的 host 网络，入口请跑本机进程。
services:
  umbrad:
    image: umbra/umbrad:latest
    platform: linux/${arch}
    network_mode: host
    cap_add:
      - NET_ADMIN
      - NET_BIND_SERVICE
    command: ["-listen", ":4400", "-api", "127.0.0.1:4401", "-bind", "0.0.0.0", "-tls-dir", "/var/lib/umbra"]
    restart: unless-stopped
`;
}

export function agentUnit(token: string) {
  return `[Unit]
Description=Umbra node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/umbra-agent --server gate:4400 --tls-ca /etc/umbra/ca.crt
Environment=UMBRA_TOKEN=${token}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

export function agentPlist(token: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.umbra.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/umbra-agent</string>
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

export function enrollCmd(token: string) {
  return `umbra-agent --server gate:4400 --tls-ca /etc/umbra/ca.crt --token ${token}`;
}

export function agentWinService(token: string, arch: Arch = "amd64") {
  const bin = binaryName("umbra-agent", "windows", arch);
  return `${enrollCmd(token)}

mkdir "%ProgramFiles%\\Umbra"
copy ${bin} "%ProgramFiles%\\Umbra\\umbra-agent.exe"
sc.exe create UmbraAgent binPath= "%ProgramFiles%\\Umbra\\umbra-agent.exe --server gate:4400 --tls-ca C:\\ProgramData\\umbra\\ca.crt --token ${token}" start= auto
sc.exe start UmbraAgent
`;
}

export function agentCompose(token: string, arch: Arch) {
  return `services:
  umbra-agent:
    image: umbra/umbra-agent:latest
    platform: linux/${arch}
    network_mode: host
    environment:
      UMBRA_SERVER: gate:4400
      UMBRA_TOKEN: ${token}
      UMBRA_TLS_CA: /etc/umbra/ca.crt
    restart: unless-stopped
`;
}

export function gateInstall(platform: Platform, arch: Arch) {
  const bin = binaryName("umbrad", platform, arch);
  if (platform === "docker") return umbradCompose(arch);
  if (platform === "linux") {
    return `install -m 755 ${bin} /usr/local/bin/umbrad
sudo systemctl enable --now umbrad

${umbradUnit.trim()}
`;
  }
  if (platform === "darwin") {
    return `install -m 755 ${bin} /usr/local/bin/umbrad
sudo cp io.umbra.gate.plist /Library/LaunchDaemons/
sudo launchctl load /Library/LaunchDaemons/io.umbra.gate.plist

${umbradPlist.trim()}
`;
  }
  return umbradWin(arch);
}

export function agentInstall(platform: Platform, arch: Arch, token: string) {
  const bin = binaryName("umbra-agent", platform, arch);
  if (platform === "docker") return agentCompose(token, arch);
  if (platform === "linux") {
    return `${enrollCmd(token)}

install -m 755 ${bin} /usr/local/bin/umbra-agent
sudo systemctl enable --now umbra-agent

${agentUnit(token).trim()}
`;
  }
  if (platform === "darwin") {
    return `${enrollCmd(token)}

install -m 755 ${bin} /usr/local/bin/umbra-agent
sudo cp io.umbra.agent.plist /Library/LaunchDaemons/
sudo launchctl load /Library/LaunchDaemons/io.umbra.agent.plist

${agentPlist(token).trim()}
`;
  }
  return agentWinService(token, arch);
}
