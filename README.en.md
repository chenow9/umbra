# Umbra (幽门)

[中文 README](README.md) · [Requirements (zh)](docs/幽门-L4隐匿穿透-需求分析与技术报告.md) · [Protocol draft (zh)](docs/M1-接口草案.md)

Self-hosted **L4 (TCP / UDP)** stealth intranet-penetration gateway.

Nodes only keep the gate address and a credential. Mappings, modes and ACL live on the server, are pushed to online nodes, and take effect without touching client files, restarting the gate, or dropping existing connections.

## Why not NPS / Pangolin / frp

NPS has the right control model (change it on the server, the client executes) and the wrong security history. Pangolin needs Traefik static entrypoints and a restart for raw TCP/UDP. Orbien needs a pre-mapped port pool. frp keeps truth in `frpc.toml` on the client.

Umbra stacks five requirements:

1. L4 only — TCP and UDP. No user-traffic L7 reverse proxy.
2. **Server is the only config truth.** After install, the node is not edited.
3. The gate binds and releases ports at runtime; in-flight connections on other mappings stay up.
4. Default stealth (SPA / visitor). Public ports are an explicit mode.
5. Per-node and per-mapping traffic stats, plus a spare console.

Out of scope: exposing `frpc.toml`, NPS protocol compatibility, an internet login system for the product.

## Pieces

| Binary | Role |
|---|---|
| `umbrad` | Public gate. TLS 1.3 control channel, business listeners, nftables DROP, hot upgrade |
| `umbra-agent` | Node behind NAT. Dials local targets from server-pushed mappings |
| Console | Overview / nodes / mappings / traffic / audit / deploy |

## Modes

- **SPA (dark port):** unauthorized packets are dropped in-kernel on Linux (`CAP_NET_ADMIN`). Without that capability the process closes the socket in user space.
- **Public:** an explicitly opened business port (e.g. game UDP).
- **Visitor:** no business listener on the gate; a ticket makes the Agent dial out.

## Quick start

**Build**

```bash
go 1.24+
./scripts/build-binaries.sh
# dist/: linux / darwin / windows × amd64 / arm64
```

**Gate**

```bash
sudo ./dist/umbrad_linux_amd64 \
  -listen :4400 \
  -api 127.0.0.1:4401 \
  -bind 0.0.0.0 \
  -tls-dir /var/lib/umbra
```

First start writes `ca.crt`, `gate.crt`, `gate.key` under `-tls-dir`. Copy `ca.crt` to every Agent host.

**Node** (token is issued once in the console)

```bash
./umbra-agent \
  --server gate.example:4400 \
  --tls-ca /etc/umbra/ca.crt \
  --token umbra_boot_…
```

**Console**

```bash
npm install
npm run dev
```

Add or edit mappings in the console. Do not edit files on the node. systemd / launchd / Windows service / Docker snippets are on the Deploy page.

### Docker (public gate + private node)

Push a semver tag (`v1.2.3`) to build **linux/amd64** and **linux/arm64** images and push them to Docker Hub:

- `chenow9/umbrad`
- `chenow9/umbra-agent`

Tags: `1.2.3`, `1.2`, and `latest` on non-prerelease tags.

```bash
git tag v0.1.0
git push origin v0.1.0
```

**Gate** (Linux host networking):

```bash
docker compose -f deploy/compose.gate.yml up -d
```

**Node** (host networking so mappings can target the host's `127.0.0.1`):

```bash
cp deploy/agent.env.example agent.env   # set UMBRA_SERVER / UMBRA_TOKEN
# copy the gate's ca.crt into the current directory
docker compose -f deploy/compose.agent.yml up -d
```

Hot-replace the gate binary without dropping tunnels:

```bash
kill -USR2 $(pidof umbrad)   # or: systemctl reload umbrad
```

Existing splices stay in the old process until they end; new accepts go to the new process.

## Platforms

| | amd64 | arm64 |
|---|---|---|
| Linux | ✓ | ✓ |
| macOS | ✓ | ✓ |
| Windows | ✓ | ✓ |
| Docker (linux, host network) | ✓ | ✓ |

Kernel DROP is Linux-only. macOS / Windows gates still close in user space. Docker gate needs real host networking on a Linux host.

## Layout

```
cmd/umbrad          gate
cmd/umbra-agent     node
internal/           mux, policy, nftables, TLS, upgrade
src/                console (React)
docs/               requirements and protocol
scripts/            cross-compile and smoke tests
deploy/             gate / node Compose files
.github/workflows   tag-triggered multi-arch images
```

## Security

- Control channel is TLS 1.3; nodes require `--tls-ca`.
- Keep the console on a network you already reach. Do not publish it.
- For nmap `filtered` on dark ports, run the gate with `CAP_NET_ADMIN`.
- Bootstrap tokens are shown once; revoke them in the console.
