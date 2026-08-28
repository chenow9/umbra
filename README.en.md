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
| `umbra-node` | Node behind NAT. Dials local targets from server-pushed mappings |
| `umbra-visit` | Visitor client. A server-issued ticket opens a local L4 (TCP/UDP) port; the gate does not listen on a business port |
| Console | Overview / nodes / mappings / traffic / audit / deploy. Same HTTP port as the API; set a password on first open |

## Modes

- **SPA (dark port):** unauthorized packets are dropped in-kernel on Linux (`CAP_NET_ADMIN`). Without that capability the process closes the socket in user space.
- **Public:** an explicitly opened business port (e.g. game UDP).
- **Visitor:** no business listener on the gate. Issue a ticket, then run `umbra-visit --server … --ticket … --local 127.0.0.1:2222` on the accessing machine. Local listen is L4 only (TCP or UDP).

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
  -http 127.0.0.1:8080 \
  -bind 0.0.0.0 \
  -tls-dir /var/lib/umbra
```

First start writes `ca.crt`, `gate.crt`, `gate.key` under `-tls-dir`. Copy `ca.crt` to every node host.

**Node** (token is issued once in the console)

```bash
./umbra-node \
  --server gate.example:4400 \
  --tls-ca /etc/umbra/ca.crt \
  --token umbra_boot_…
```

**Console**

`umbrad -http` serves the API and the static UI on one port (default `127.0.0.1:8080`). First visit sets a local password.

In development Vite reverse-proxies `/v1` to the gate. In production put the built UI in `-ui`, or put nginx in front of the same port.

Add or edit mappings in the console. Do not edit files on the node. systemd / launchd / Windows service / Docker snippets are on the Deploy page.

### Docker (public gate + private node)

The gate container is the control plane: `-http` serves the UI and API on one port (default `:8080`). Nodes use `:4400` TLS. The console is compiled into `umbrad` at image build time; first visit sets a password. Do not run a separate `npm run dev` in production.

Push a semver tag (`v1.2.3`) to build **linux/amd64** and **linux/arm64** images and push them to Docker Hub:

- `chenow9/umbrad`
- `chenow9/umbra-node`

Tags: `1.2.3`, `1.2`. `latest` is only applied on tags without `-`. A prerelease such as `v0.0.1-beta` publishes `0.0.1-beta` only.

```bash
git tag v0.1.0
git push origin v0.1.0
```

**Gate** (Linux host networking):

```bash
UMBRA_TAG=0.0.1-beta docker compose -f deploy/compose.gate.yml up -d
# open http://gate:8080 and set a password on first visit
```

The console binds loopback by default. A non-loopback `-http` address requires `-http-tls-cert`/`-http-tls-key` (or `-http-tls` to reuse the gate certs). Plain HTTP on a public address is refused at startup.

**Node** (host networking so mappings can target the host's `127.0.0.1`):

```bash
cp deploy/node.env.example node.env   # set UMBRA_SERVER / UMBRA_TOKEN
# copy the gate's ca.crt into the current directory
UMBRA_TAG=0.0.1-beta docker compose -f deploy/compose.node.yml up -d
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
cmd/umbra-node     node
cmd/umbra-visit     visitor (local L4)
internal/           mux, policy, nftables, TLS, upgrade, control HTTP
src/                console (React; production is umbrad -http / -ui)
docs/               requirements and protocol
scripts/            cross-compile and smoke tests
deploy/             gate / node Compose files
.github/workflows   CI: vet / test / race / govulncheck; tag images only after CI passes
```

## Security

- Control channel is TLS 1.3; nodes require `--tls-ca`.
- Release images are built with Go 1.25.14 (digest-pinned). A `v*` tag runs vet, `-race` tests, and govulncheck before any push.
- Console defaults to `127.0.0.1`; non-loopback binds require TLS. Node tokens expire and must be rotated.
- For nmap `filtered` on dark ports, run the gate with `CAP_NET_ADMIN`.
- Bootstrap tokens are shown once; revoke them in the console.
