# umbra

[中文 README](README.md)

Self-hosted **L4 (TCP / UDP)** stealth intranet-penetration gateway.

Nodes only keep the gate address and a credential. Mappings, modes and ACL live on the server, are pushed to online nodes, and take effect without touching client files, restarting the gate, or dropping existing connections.

## What it does

Expose TCP / UDP services behind NAT through a self-hosted gate, with business ports hidden from scanners by default.

1. L4 only — TCP and UDP. No user-traffic L7 reverse proxy.
2. **Server is the only config truth.** A node keeps the gate address and a credential. Mappings, modes and ACL are edited in the console and pushed live; you do not log into the node to edit files.
3. The gate binds and releases ports at runtime; in-flight connections on other mappings stay up. Replace the gate binary with USR2; existing tunnels stay in the old process until they end.
4. Three mapping modes: `public` (open; default for new mappings), `spa` (knock), `visitor` (no business listener on the gate; a ticket opens a local L4 port on the accessing machine).
5. Per-node and per-mapping live rate plus cumulative traffic. The console and API share one HTTP port; first visit sets a local password.

## Pieces

| Binary | Role |
|---|---|
| `umbrad` | Public gate. TLS 1.3 control channel, business listeners, `spa` nftables DROP, hot upgrade, console |
| `umbra-node` | Node behind NAT. Dials local targets from server-pushed mappings |
| `umbra-visit` | Visitor client. A server-issued ticket opens a local L4 (TCP/UDP) port; the gate does not listen on a business port |
| Console | Overview / nodes / mappings / traffic / audit / deploy. Same HTTP port as the API; set a password on first open |

## Mapping modes

The console and API use these identifiers (hints in the UI):

| Mode | Business listener on the gate | How you connect |
|---|---|---|
| `spa` (knock) | Yes. Unauthorized sources are dropped in-kernel on Linux (`CAP_NET_ADMIN`). Without that capability the process closes the socket in user space. Console **Knock** grants the source IP; default window 60s, new connections only. | Knock, then connect to the entry port |
| `visitor` (encrypted tunnel) | No. The gate does not listen on a business port. | Issue a ticket (`umbra_vis_…`, 24 hours), run `umbra-visit` on the accessing machine |
| `public` (open) | Yes. Visible to scanners; anyone can connect (optional CIDR allow-list). | Connect to the entry port, e.g. game UDP |

New mappings default to `public`. Choose `spa` when the port should stay hidden.

## Quick start

**Build**

```bash
# go.mod: Go 1.25 (toolchain 1.25.14)
./scripts/build-binaries.sh
# dist/: linux / darwin / windows × amd64 / arm64
```

**Gate**

```bash
sudo ./dist/umbrad_linux_amd64 \
  -listen :4400 \
  -advertise gate.example.com:4400 \
  -http 127.0.0.1:8080 \
  -bind 0.0.0.0 \
  -tls-dir /var/lib/umbra
```

First start writes `ca.crt`, `gate.crt`, `gate.key` under `-tls-dir`.  
`-advertise` is the address nodes and visitors actually dial; it only fills generated install/visit commands and does not change the listen address.

`-tls-dir` also accumulates:

- `control.json` — owner password, sessions, node tokens, mappings (including cumulative bytes)
- `traffic` — rate-curve samples (written about every 10 seconds)
- `state.json` — hot-upgrade restore state

**Node** (token is issued once in the console)

Console **Nodes → Enroll** issues `umbra_boot_…` (shown once). The dialog includes a host install command and a Docker command with the gate CA already embedded, so you do not have to scp `ca.crt` separately.

Manual equivalent:

```bash
./umbra-node \
  --server gate.example.com:4400 \
  --tls-ca /etc/umbra/ca.crt \
  --token umbra_boot_…
```

Node tokens default to 90 days, or never expire per node. Rotate before expiry, or revoke at any time. After rotate, the old token stays valid for about 90 seconds.

**Console**

`umbrad -http` serves the API and the static UI on one port (default `127.0.0.1:8080`). First visit sets a local password.

In development Vite reverse-proxies `/v1` to the gate. In production put the built UI in `-ui`, or put nginx in front of the same port.

Add or edit mappings in the console. Do not edit files on the node. systemd / launchd / Windows service / Docker snippets are on the Deploy page.

The console binds loopback by default. A non-loopback `-http` address requires `-http-tls-cert`/`-http-tls-key` (or `-http-tls` to reuse the gate certs). Plain HTTP on a public address is refused at startup.

**Visitor** (`visitor` mode only)

Install `umbra-visit` on the machine that should reach the intranet service. In **Mappings**, issue a ticket for a `visitor` mapping, then run the command shown once:

```bash
umbra-visit --server gate.example.com:4400 \
  --tls-ca /etc/umbra/ca.crt \
  --ticket umbra_vis_… \
  --local 127.0.0.1:2222
```

Then point the business client at `127.0.0.1:2222`. `umbra-visit` is an on-demand process on the accessing side — not on the gate or the intranet node. Stopping it closes the local port. Platform snippets are on **Deploy → umbra-visit**. The `chenow9/umbrad` image already contains `umbra-visit`.

## Docker (public gate + private node)

The gate container is the control plane: `-http` serves the UI and API on one port (default `127.0.0.1:8080`). Nodes use `:4400` TLS. The console is compiled into `umbrad` at image build time; first visit sets a password. Do not run a separate `npm run dev` in production.

Push a semver tag (`v1.2.3`) to build **linux/amd64** and **linux/arm64** images and push them to Docker Hub:

- `chenow9/umbrad` (includes `umbrad` and `umbra-visit`)
- `chenow9/umbra-node`

Tags: `1.2.3`, `1.2`. `latest` is only applied on tags without `-`. A prerelease such as `v0.0.1-beta` publishes `0.0.1-beta` only.

```bash
git tag v0.1.0
git push origin v0.1.0
```

**Gate** (Linux host networking):

```bash
UMBRA_TAG=0.0.1-beta docker compose -f deploy/compose.gate.yml up -d
# open the console (default bind is 127.0.0.1:8080)
# named volume umbra-tls → /var/lib/umbra holds certs, control.json, and traffic.
# Do not mount only ca.crt.
```

`deploy/compose.gate.yml` already sets `-advertise gate.example.com:4400`; change it to the address nodes can actually reach.

**Node** (host networking so mappings can target the host's `127.0.0.1`):

The enroll dialog's Docker command writes the CA locally and runs `docker run --network host`. Compose still works:

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

Kernel DROP for `spa` is Linux-only. macOS / Windows gates still close in user space. Docker gate needs real host networking on a Linux host.

## Layout

```
cmd/umbrad          gate
cmd/umbra-node      node
cmd/umbra-visit     visitor (local L4)
internal/           mux, policy, nftables, TLS, upgrade, control HTTP
src/                console (React; production is umbrad -http / -ui)
scripts/            cross-compile and smoke tests
deploy/             gate / node Compose files
.github/workflows   CI: vet / test / race / govulncheck; tag images only after CI passes
```

Common `umbrad` flags (`umbrad -h`):

| Flag | Default | Role |
|---|---|---|
| `-listen` | `:4400` | node control channel |
| `-advertise` | empty (same as listen) | address written into install/visit commands |
| `-http` | `127.0.0.1:8080` | console and API |
| `-bind` | `127.0.0.1` | business-port bind; use `0.0.0.0` on a public gate |
| `-tls-dir` | `/var/lib/umbra` | certs, state, `control.json`, `traffic` |
| `-stealth` | `auto` | `nft` / `off` / `auto` |
| `-udp` | `auto` | UDP data plane: `auto` / `required` / `yamux` |

Node: `--server`, `--token`, `--tls-ca`. Visitor also needs `--ticket` and `--local`.

## Security

- Control channel is TLS 1.3; nodes require `--tls-ca`. Newly issued CAs use subject `umbra CA` (an existing tls-dir is not rewritten).
- Release images are built with Go 1.25.14 (digest-pinned). A `v*` tag runs vet, `-race` tests, and govulncheck before any push.
- Console defaults to `127.0.0.1`; non-loopback binds require TLS.
- Node tokens default to 90 days or never expire. Visitor tickets last 24 hours. Tokens are shown once; revoke them in the console.
- For nmap `filtered` on `spa` mappings, run the gate with `CAP_NET_ADMIN`.
- Mapping targets default to loopback or RFC1918 only.
