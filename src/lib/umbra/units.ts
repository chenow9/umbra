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

export const umbradUnit = `[Unit]
Description=Umbra Gate
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/umbrad -tls-dir /var/lib/umbra -listen :4400 -advertise gate.example.com:4400 -http 127.0.0.1:8080 -bind 0.0.0.0
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
    <string>-advertise</string>
    <string>gate.example.com:4400</string>
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
sc.exe create UmbraGate binPath= "%ProgramFiles%\\Umbra\\umbrad.exe -tls-dir C:\\ProgramData\\umbra -listen :4400 -advertise gate.example.com:4400 -http 127.0.0.1:8080 -bind 0.0.0.0" start= auto
sc.exe start UmbraGate
`;
}

export function umbradCompose(arch: Arch) {
  return `# Linux 宿主机才能用 host 网络收入口端口。
# macOS / Windows 上的 Docker 没有真正的 host 网络，入口请跑本机进程。
# 镜像由 git tag（v*）触发 CI 推到 Docker Hub，linux/amd64 + linux/arm64。
# -http 是控制台+API；预发布不打 latest，例如 UMBRA_TAG=0.0.1-beta。
# umbra-tls 挂到 /var/lib/umbra：证书 + control.json（口令/会话/节点/映射）。
services:
  umbrad:
    image: ${DOCKERHUB_GATE}:\${UMBRA_TAG:-latest}
    platform: linux/${arch}
    network_mode: host
    cap_add:
      - NET_ADMIN
      - NET_BIND_SERVICE
    # tls-dir 必须整目录持久化：口令、会话、节点凭证、映射都在 control.json。
    command: ["-listen", ":4400", "-advertise", "gate.example.com:4400", "-http", "127.0.0.1:8080", "-bind", "0.0.0.0", "-tls-dir", "/var/lib/umbra"]
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

export function shSingleQuote(s: string) {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
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

export function nodeEnrollBinCmd(token: string, server?: string, caPem?: string) {
  const srv = shSingleQuote(enrollServer(server));
  const tok = shSingleQuote(token);
  const pem = caPem?.trim();
  if (!pem) {
    return `# 先把入口 ca.crt 放到 /etc/umbra/ca.crt，再执行：
umbra-node --server ${srv} --tls-ca /etc/umbra/ca.crt --token ${tok}
`;
  }
  return withCAHeredoc(
    pem,
    `# 入口 CA 已包含在命令中，不必再下载或 scp。
mkdir -p /etc/umbra
if [ -d /etc/umbra/ca.crt ]; then rm -rf /etc/umbra/ca.crt; fi
cat >/etc/umbra/ca.crt <<'UMBRA_CA'`,
    `umbra-node --server ${srv} --tls-ca /etc/umbra/ca.crt --token ${tok}
`,
  );
}

export function nodeEnrollDockerCmd(token: string, server?: string, caPem?: string) {
  const srv = shSingleQuote(enrollServer(server));
  const tok = shSingleQuote(token);
  const pem = caPem?.trim();
  const head = `# 入口 CA 已包含在命令中，不必再下载或 scp。
# --network host 让映射目标 127.0.0.1 指向这台机器。
# 若提示 name already in use：docker rm -f umbra-node`;
  const run = `docker run -d --name umbra-node --network host --restart unless-stopped \\
  -v "$HOME/.umbra/ca.crt":/etc/umbra/ca.crt:ro \\
  ${DOCKERHUB_NODE}:latest \\
  --server ${srv} --tls-ca /etc/umbra/ca.crt --token ${tok}
`;
  if (!pem) {
    return `${head}
# 把入口 ca.crt 放到当前目录后执行：
docker run -d --name umbra-node --network host --restart unless-stopped \\
  -v "$PWD/ca.crt":/etc/umbra/ca.crt:ro \\
  ${DOCKERHUB_NODE}:latest \\
  --server ${srv} --tls-ca /etc/umbra/ca.crt --token ${tok}
`;
  }
  return withCAHeredoc(
    pem,
    `${head}
umask 077
mkdir -p "$HOME/.umbra"
if [ -d "$HOME/.umbra/ca.crt" ]; then rm -rf "$HOME/.umbra/ca.crt"; fi
cat >"$HOME/.umbra/ca.crt" <<'UMBRA_CA'`,
    run,
  );
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
