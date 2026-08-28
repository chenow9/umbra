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

export function platformLabel(os: string, arch: string) {
  const p = PLATFORMS.find((x) => x.id === os)?.label ?? os;
  return `${p} ${arch}`;
}

function goos(platform: Platform) {
  return platform === "docker" ? "linux" : platform;
}

export function binaryName(kind: "umbrad" | "umbra-node", platform: Platform, arch: Arch) {
  const ext = goos(platform) === "windows" ? ".exe" : "";
  return `${kind}_${goos(platform)}_${arch}${ext}`;
}

export const umbradUnit = `[Unit]
Description=Umbra Gate
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/umbrad -tls-dir /var/lib/umbra -listen :4400 -http 127.0.0.1:8080 -bind 0.0.0.0
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
    <string>-listen</string>
    <string>:4400</string>
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

export function umbradWin(arch: Arch) {
  const bin = binaryName("umbrad", "windows", arch);
  return `mkdir "%ProgramFiles%\\Umbra"
copy ${bin} "%ProgramFiles%\\Umbra\\umbrad.exe"
sc.exe create UmbraGate binPath= "%ProgramFiles%\\Umbra\\umbrad.exe -tls-dir C:\\ProgramData\\umbra -listen :4400 -http 127.0.0.1:8080 -bind 0.0.0.0" start= auto
sc.exe start UmbraGate
`;
}

export function umbradCompose(arch: Arch) {
  return `# Linux 宿主机才能用 host 网络收入口端口。
# macOS / Windows 上的 Docker 没有真正的 host 网络，入口请跑本机进程。
# 镜像由 git tag（v*）触发 CI 推到 Docker Hub，linux/amd64 + linux/arm64。
# -http 是控制台+API；预发布不打 latest，例如 UMBRA_TAG=0.0.1-beta。
services:
  umbrad:
    image: ${DOCKERHUB_GATE}:\${UMBRA_TAG:-latest}
    platform: linux/${arch}
    network_mode: host
    cap_add:
      - NET_ADMIN
      - NET_BIND_SERVICE
    command: ["-listen", ":4400", "-http", "127.0.0.1:8080", "-bind", "0.0.0.0", "-tls-dir", "/var/lib/umbra"]
    volumes:
      - umbra-tls:/var/lib/umbra
    restart: unless-stopped

volumes:
  umbra-tls:
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

export function enrollCmd(token: string) {
  return `umbra-node --server gate:4400 --tls-ca /etc/umbra/ca.crt --token ${token}`;
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
