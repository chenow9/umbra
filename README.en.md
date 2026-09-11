# Umbra

<p align="center">
  <img src="public/og.jpg" alt="Umbra" width="900">
</p>

<p align="center"><strong>A self-hosted gateway for private TCP and UDP services</strong></p>

<p align="center">
  <a href="https://github.com/chenow9/umbra/actions/workflows/ci.yml"><img src="https://github.com/chenow9/umbra/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/chenow9/umbra/releases/latest"><img src="https://img.shields.io/github/v/release/chenow9/umbra" alt="Release"></a>
  <a href="https://github.com/chenow9/umbra/releases"><img src="https://img.shields.io/github/downloads/chenow9/umbra/total?label=Release%20Downloads" alt="Release Downloads" title="Total asset downloads across all releases (includes binaries and checksums; excludes temporary Actions artifacts)"></a>
  <a href="https://hub.docker.com/r/chenow9/umbrad"><img src="https://img.shields.io/docker/pulls/chenow9/umbrad?label=Docker%20Pulls" alt="Docker Pulls"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/chenow9/umbra" alt="License"></a>
</p>

<p align="center">
  <a href="https://umbrad.grok.me">Website</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#console-two-factor-authentication">2FA</a> ·
  <a href="#security-model-and-limitations">Security</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="README.md">简体中文</a>
</p>

Umbra connects TCP and UDP services behind NAT or firewalls to a public gateway you control. Service settings, access modes, and CIDR rules are centrally managed on the gateway and pushed to online nodes. A node only needs the gateway address, its node credential, and the trusted CA; service settings are managed in the console.

## Gateways, nodes, and services

This guide uses the names shown in the console. The workflow is: **deploy a gateway → enroll a node → add a service → choose its access mode → connect**.

| Name | Meaning | Program or technical name |
| --- | --- | --- |
| Gateway | Runs on a public server, hosts the console, and accepts node tunnels and client connections | `umbrad` |
| Node | Runs on a machine that can reach the private target and initiates a connection to the gateway | `umbra-node` |
| Service | A forwarding configuration under a node, with a target address, protocol, access mode, and entry port when needed | Called a Mapping in the API and protocol |
| Visitor client | Runs on the user's machine for Ticket access and connects to the gateway with an access ticket | `umbra-visit` |

A node can have multiple services. Older documentation called services “mappings.” Technical identifiers retain that name: the `/v1/mappings` API path, the `mappingId` field, and `MappingSync` / `MappingAck` protocol messages. “Port mapping” describes the relationship between entry and target ports.

A **node credential** lets a node connect to the gateway. An **access ticket** lets a visitor client connect to a particular service and is passed as `--ticket`. These credentials serve different purposes. The access-mode table below relates the UI labels to their `mode` values.

<a id="service-workspace"></a>

The console opens on **Nodes**. Open a node to view its services; **All services** and quick search find services across nodes. **Observe** provides traffic and audit views, and **System** contains security and appearance settings.

## Why Umbra

- **Centralized management** — Manage nodes, services, access modes, ACLs, and credentials from one web console.
- **TCP and UDP forwarding** — Carry SSH, RDP, databases, game traffic, and custom protocols without requiring an L7 proxy.
- **Three access modes** — Choose Ticket access, Temporary allow, or Public access independently for each service.
- **Live configuration** — Create, edit, enable, disable, or remove services without restarting the gateway or logging into every node.
- **Built-in visibility** — Inspect node status, service reachability, real-time throughput, cumulative traffic, drop counters, and audit events.
- **Graceful replacement** — On Unix, `SIGUSR2` hands new connections to a new gateway process while the old process drains established tunnels.

Umbra fits home labs, remote development, private services, game UDP, and temporary third-party access. It does not provide HTTP routing, a WAF, or a global edge network; pair it with a dedicated L7 proxy such as nginx or Caddy when those capabilities are required.

## Choose an access mode

Choose an access mode in the **Who can reach it** step when adding a service. The labels and order below match the console; the `mode` column is for API and configuration reference.

| UI label | `mode` value | Public exposure | How to connect | Best suited for |
| --- | --- | --- | --- | --- |
| Ticket access | `visitor` | No public service port is opened for the service | Issue an access ticket (24 hours by default), then run `umbra-visit` to open a local port on the client machine | Private services that should not expose a public service port |
| Temporary allow | `spa` | The gateway listens on a service port; on Linux with nftables, unauthorized traffic is dropped in the kernel | Temporarily authorize the source IP, then connect with the original client; the default 60-second window affects new connections only | SSH, RDP, and administrative services where reduced scan exposure is useful |
| Public access | `public` | The gateway listens on a service port visible to scanners | Connect with the original client; an optional CIDR allowlist can restrict sources | Public services, game UDP, or applications with their own strong authentication |

> New console services default to **Ticket access**, without a public service listener. For compatibility, API clients that omit `mode` retain the `public` (Public access) default.

### Access flow animations

These recordings of the [website's access mode demos](https://umbrad.grok.me/#modes) illustrate the flows, not actual timing. In the diagrams, `gate` is the public gateway, `node` is the private-network node, and `service` is the target service.

**Ticket access (`visitor`)**

The visitor runs `umbra-visit` (shown as `visit`) and connects through a ticketed tunnel. `closed` means no public service port is open; the gateway still accepts tunnel connections.

<img src="docs/images/access-modes/visitor.gif" alt="Ticket access: the visitor client connects through the gateway tunnel and node to the target service, without a public service port" width="640">

**Temporary allow (`spa`)**

Unauthorized source traffic is dropped (`drop`). After a temporary authorization request (`knock`), the allowed source IP can connect with the original client during the authorization window.

<img src="docs/images/access-modes/spa.gif" alt="Temporary allow: unauthorized traffic is dropped; after source IP authorization, the client connects through the gateway and node to the target service" width="640">

**Public access (`public`)**

The gateway opens a public service port (`open`). The original client (`client`) connects directly to that port, and the gateway forwards traffic through the node to the target service.

<img src="docs/images/access-modes/public.gif" alt="Public access: the client connects to the open public service port, and traffic is forwarded through the gateway and node to the target service" width="640">

## How it works

```text
Public access / Temporary allow client ── service port──┐
Ticket access (umbra-visit) ── ticketed tunnel──────────├──▶ Gateway (umbrad) ══ TLS / Yamux ══ Node (umbra-node) ──▶ private service
Console / API ── service settings and access policy─────┘
```

The node initiates a long-lived TLS 1.3 connection to `umbrad`. Yamux multiplexes the control stream and concurrent TCP service streams over that connection. The gateway is the source of truth: it sends `MappingSync` updates to online nodes, nodes reply with `MappingAck`, and a reconnect delivers a complete service configuration snapshot.

UDP prefers a separate data plane when available and can fall back to Yamux, depending on configuration. A service configuration acknowledgement confirms configuration delivery; **Probe** sends data through Gateway → Node → local target to check reachability.

## Components

| Component     | Role                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `umbrad`      | Public gateway: TLS 1.3 tunnels, service listeners, kernel drops for Temporary allow, graceful upgrade, web console, and API |
| `umbra-node`  | Node behind NAT: connects outward to the gateway and dials local targets from service settings pushed by the gateway         |
| `umbra-visit` | Visitor client: uses a ticket to establish a tunnel and opens a local TCP or UDP port                          |
| Web console   | Manages nodes, services, credentials, traffic, audit events, and security settings                           |

## Quick start

The recommended gateway deployment uses Docker Compose on a public Linux host. Allow nodes to reach `4400/TCP`; also allow `4400/UDP` when using the separate UDP data plane. Open each service’s entry port as required.

**1. Start the public gateway**

```bash
git clone https://github.com/chenow9/umbra.git
cd umbra

# Replace gate.example.com:4400 in deploy/compose.gate.yml
# with the domain or public IP that nodes can actually reach.
UMBRA_TAG=0.3.0 docker compose -f deploy/compose.gate.yml up -d
docker logs -f umbrad
```

The gateway container uses host networking and stores certificates, credentials, services, and traffic data in the `umbra-tls` volume. Pin a release version in production instead of following `latest`.

**2. Open the console**

The management endpoint listens on `127.0.0.1:8080` by default. Forward it securely from your workstation:

```bash
ssh -L 8080:127.0.0.1:8080 user@gate.example.com
```

Open `http://127.0.0.1:8080`. The first visit sets the administrator password, enrolls an authenticator, and displays one-time recovery codes. Initialization is complete only after you save those codes.

For domain access, use an HTTPS reverse proxy or configure management TLS in `umbrad`. Never expose the plaintext management endpoint to the Internet. See [Console two-factor authentication](#console-two-factor-authentication) for upgrades, recovery, and configuration.

When the console is accessed through a reverse proxy, the client address must also be forwarded and trusted correctly. Otherwise a Temporary allow action may authorize the proxy address instead of the actual client. See [Reverse proxies and client IP addresses](#reverse-proxies-and-client-ip-addresses).

Do not set `UMBRA_LOGIN=off`, `GROK_AGENT`, or `GROK_PROJECT_ID` on a production gateway; they disable console authentication entirely.

**3. Enroll a node**

Open **Nodes → Enroll node**, select the target platform, and run the generated installation command. The `umbra_boot_…` node credential is displayed only once; the command includes the gateway CA and native service configuration.

**4. Add and connect a service**

Open an enrolled node and choose **Add service**. Follow **Where is the service → Who can reach it → Confirm and connect**. The node is preselected; enter a target address and port reachable by that node, then choose Ticket access, Temporary allow, or Public access. **All services** and quick search find services across nodes. Limits and timeouts are in the advanced settings. Saving opens the service's **Connect** panel:

- **Config ready** means the node confirmed the latest configuration; it does not prove target health or external reachability.
- **Probe** sends a real request through Gateway → Node → local target to help verify reachability.
- **Ticket access**: issue an access command, run `umbra-visit` on the user's machine, then connect to the local port.
- **Temporary allow**: choose **Temporarily allow my IP**, then connect to the entry port with the original client before the authorization expires.
- **Public access**: connect to the entry port with the original client.

> Probe sends a small payload to the real target. It checks path and response behavior; it is not an application-level health check.

**5. Copy nodes and services between public gateways**

When the same application hostname is routed to several independent `umbrad` instances, export selected nodes and services from a configured gateway and import them on the others instead of recreating services by hand. Export and import are available on **Nodes** and on a node’s service view.

- The JSON file includes `schemaVersion`. Nodes carry reusable fields such as name and note; services carry protocol, public port, intranet host/port, access mode, enabled state, allowlists, rate limits, connection caps, and timeouts.
- Node credentials, certificate private keys, console authentication material, access tickets, and runtime status are **not** exported. Portable origin IDs identify repeats; source database IDs are not reused as destination entity IDs.
- Import parses and previews before writing. Each source node can create a new node (the existing enrollment flow, with a distinct identity and a once-shown credential) or bind an existing node on the destination. Matched services default to skip; update requires a visible diff. Unrelated local services are not taken over, and local services missing from the file are not deleted.
- Public-port conflicts follow this gateway’s listen rules, including conflicts inside the import batch—not per-node uniqueness only.
- After a successful save, the existing push, generation, and ACK path still applies. An offline node or pending ack is reported as waiting to sync, not as a failed import. Disabled services stay disabled.
- Copying configuration does **not** create an intranet tunnel. New nodes must still be deployed on the private network and connected to **this** public gateway.

### Reverse proxies and client IP addresses

`UMBRA_HTTP_TRUST_PROXY` (or `-http-trust-proxy`) specifies which **reverse proxies directly connected to `umbrad`** may supply the real client address. Configure it with the proxy IP address or CIDR, not a visitor's public IP and not an access allowlist for mapped services.

The resolution rules are:

- If the HTTP request's direct peer is not trusted, `umbrad` ignores forwarding headers and uses the TCP peer address. Leave this setting empty when clients access the console directly without a reverse proxy.
- If the direct peer belongs to a trusted proxy CIDR, `umbrad` uses the first address in `X-Forwarded-For`, then `X-Real-IP`, and finally falls back to the TCP peer address.
- The resolved address is used for console login, audit events, and the source IP authorized by a Temporary allow action. Client connections to Public access and Temporary allow service ports remain direct and do not need to pass through the HTTP reverse proxy.

For example, when Nginx on the same host reaches `umbrad` over loopback:

```yaml
services:
  umbrad:
    environment:
      # This is the proxy directly connected to umbrad, not the client's public IP.
      UMBRA_HTTP_TRUST_PROXY: 127.0.0.0/8
    command:
      - -http
      - 127.0.0.1:8080
```

When Nginx is the outermost proxy, overwrite any client-supplied `X-Forwarded-For` value instead of preserving or blindly appending it:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

If the proxy runs on a Docker bridge or another host, use the address from which it actually connects to `umbrad`. Prefer an exact `/32` or `/128` over a broad network whenever possible. In a multi-proxy chain, the outermost trusted edge must remove forged client forwarding headers, and downstream proxies must propagate the sanitized value correctly. Never trust `0.0.0.0/0` or `::/0`; doing so could let any directly connected client spoof its source address.

After changing a Compose environment variable, run `docker compose up -d umbrad` so Compose recreates the service; `docker restart` alone does not add a new variable to an existing container. Once active, inspect `mapping.knock` on the Audit page. Its IP should match the egress IP of the client that opens the mapped service, rather than `127.0.0.1` or a Docker bridge address.

## Console two-factor authentication

Starting with `v0.1.5`, the console enables TOTP 2FA by default. It works with 1Password, Google Authenticator, Microsoft Authenticator, and other applications that generate six-digit TOTP codes. Keep the gateway and phone clocks synchronized.

| Scenario | Required credentials | Procedure |
| -------- | -------------------- | --------- |
| New installation | New administrator password | Scan the QR code, submit a six-digit code, and save the 10 one-time recovery codes |
| Normal login | Password + TOTP | Password + one unused recovery code also works |
| Upgrade from an older release | Existing password + local migration code | Existing sessions are revoked; read `2fa-bootstrap` and enroll an authenticator |
| Lost phone | Password + recovery code | Sign in, then use **Deploy → Console authentication** to replace the binding and generate new recovery codes |
| Lost phone and recovery codes | Local server access + existing password | Stop the daemon, run offline `-reset-2fa`, then enroll with the migration code |

After upgrading from a release without 2FA, read the one-time migration code on the gateway:

```bash
# Docker Compose
docker exec umbrad cat /var/lib/umbra/2fa-bootstrap

# Binary deployment
sudo cat /var/lib/umbra/2fa-bootstrap
```

The code is never written to logs, and the file is deleted after enrollment. Never paste the migration code, TOTP secret, QR code, or recovery codes into chats, tickets, or logs.

If both the phone and recovery codes are lost, stop the running gateway and reset 2FA offline:

```bash
# Binary/system-service deployment
sudo systemctl stop umbrad
sudo umbrad -reset-2fa -tls-dir /var/lib/umbra
sudo systemctl start umbrad

# Docker Compose deployment
docker compose -f deploy/compose.gate.yml stop umbrad
docker compose -f deploy/compose.gate.yml run --rm umbrad \
  -reset-2fa -tls-dir /var/lib/umbra
docker compose -f deploy/compose.gate.yml up -d umbrad
```

The reset preserves the administrator password, removes the existing TOTP binding and recovery codes, revokes every console session, and creates a new `2fa-bootstrap`. After the gateway starts, use the existing password and new migration code to enroll again.

`UMBRA_2FA` is read when the process starts:

| Value | Behavior |
| ----- | -------- |
| Unset or `on` | Default; requires password + TOTP/recovery code |
| `off` | Requires only the password but retains an existing binding; sessions issued while off become invalid when 2FA is enabled again |
| Any other value | Refuses to start, preventing a typo from silently weakening authentication |

While 2FA is off, remote authenticator replacement and recovery-code regeneration are disabled. If a binding already exists, changing the administrator password still requires the current second factor. Disabling 2FA is not recommended in production.

See [docs/2fa.en.md](docs/2fa.en.md) for the complete operations and recovery guide.

### Binary deployment

Prebuilt binaries are available from [Releases](https://github.com/chenow9/umbra/releases/latest). To build from source:

```bash
# go.mod: Go 1.25 (toolchain 1.25.14)
./scripts/build-binaries.sh
# dist/: Linux / macOS / Windows × amd64 / arm64
```

Start the gateway manually:

```bash
sudo ./dist/umbrad_linux_amd64 \
  -listen :4400 \
  -advertise gate.example.com:4400 \
  -http 127.0.0.1:8080 \
  -bind 0.0.0.0 \
  -tls-dir /var/lib/umbra
```

`-advertise` is the external address used in generated node and visitor commands; it does not change the listen address. The TLS directory contains:

- `ca.crt` / `gate.crt` / `gate.key` — gateway CA and certificates
- `control.json` — administrator password, TOTP binding, sessions, node credentials, service settings, and cumulative traffic
- `2fa-bootstrap` — one-time migration code after an upgrade or local 2FA reset; deleted after enrollment
- `traffic` — rate-curve samples (written about every 10 seconds)
- `state.json` — hot-upgrade restore state

Start a node manually:

```bash
./umbra-node \
  --server gate.example.com:4400 \
  --tls-ca /etc/umbra/ca.crt \
  --token umbra_boot_…
```

Node tokens default to 90 days, or never expire per node. Rotate before expiry, or revoke at any time. After rotate, the old token stays valid for about 90 seconds.

<details>
<summary><strong>Node system-service commands</strong></summary>

The binary install command generated by the console registers `umbra-node` as a system service. You can close the terminal after installation; the node keeps running and starts automatically with the host.

**Linux (systemd)**

```bash
# Status and recent logs
sudo systemctl status umbra-node
sudo journalctl -u umbra-node -n 100 --no-pager

# Stop temporarily; it still starts on the next boot
sudo systemctl stop umbra-node

# Start or restart
sudo systemctl start umbra-node
sudo systemctl restart umbra-node

# Stop and disable automatic startup
sudo systemctl disable --now umbra-node

# Restore automatic startup and start now
sudo systemctl enable --now umbra-node
```

Remove the Linux service completely:

```bash
sudo systemctl disable --now umbra-node
sudo rm -f /etc/systemd/system/umbra-node.service
sudo systemctl daemon-reload
sudo rm -f /usr/local/bin/umbra-node
```

**macOS (launchd)**

```bash
# Status
sudo launchctl print system/io.umbra.node

# Stop temporarily; it still starts on the next boot
sudo launchctl bootout system/io.umbra.node

# Start again
sudo launchctl bootstrap system /Library/LaunchDaemons/io.umbra.node.plist

# Restart
sudo launchctl kickstart -k system/io.umbra.node

# Stop and disable automatic startup
sudo launchctl bootout system/io.umbra.node 2>/dev/null || true
sudo launchctl disable system/io.umbra.node

# Restore automatic startup and start now
sudo launchctl enable system/io.umbra.node
sudo launchctl bootstrap system /Library/LaunchDaemons/io.umbra.node.plist
```

Remove the macOS service completely:

```bash
sudo launchctl bootout system/io.umbra.node 2>/dev/null || true
sudo launchctl disable system/io.umbra.node
sudo rm -f /Library/LaunchDaemons/io.umbra.node.plist
sudo rm -f /usr/local/libexec/umbra-node-run
sudo rm -f /usr/local/bin/umbra-node
```

**Windows (Administrator PowerShell)**

```powershell
# Status
Get-Service -Name UmbraNode

# Stop temporarily; it still starts on the next boot
Stop-Service -Name UmbraNode

# Start or restart
Start-Service -Name UmbraNode
Restart-Service -Name UmbraNode

# Stop and disable automatic startup
Stop-Service -Name UmbraNode -ErrorAction SilentlyContinue
Set-Service -Name UmbraNode -StartupType Disabled

# Restore automatic startup and start now
Set-Service -Name UmbraNode -StartupType Automatic
Start-Service -Name UmbraNode
```

Remove the Windows service completely:

```powershell
Stop-Service -Name UmbraNode -ErrorAction SilentlyContinue
sc.exe delete UmbraNode
```

Removing the system service keeps the CA and local configuration by default so the node can be reinstalled. When permanently retiring a node, revoke its credential in the console first, then remove `/etc/umbra`, `/usr/local/etc/umbra`, or `C:\ProgramData\Umbra` if desired. Removing local files does not remove the node record from the console.

</details>

<a id="visitor-client"></a>

### Ticket access client (umbra-visit)

Install `umbra-visit` on the machine that should reach the private service. From a node's service list or **All services**, open a Ticket access service's **Connect** panel, choose **Issue a 24-hour access command**, then run the command shown once:

```bash
umbra-visit --server gate.example.com:4400 \
  --tls-ca /etc/umbra/ca.crt \
  --ticket umbra_vis_… \
  --local 127.0.0.1:2222
```

Then point the service client at `127.0.0.1:2222`. `umbra-visit` runs on demand on the user's machine. Stopping it closes the local port. Client installation instructions are in the service's **Connect** panel; download and build instructions are below. The `chenow9/umbrad` image already contains `umbra-visit`.

<a id="docker-public-gate--private-node"></a>

## Docker (public gateway + private node)

The gateway container carries both control and forwarding traffic. `-http` serves the UI and API (default `127.0.0.1:8080`), while nodes connect over TLS on `:4400`. The console is embedded in `umbrad`; no separate frontend development server is needed in production.

Docker Hub provides **linux/amd64** and **linux/arm64** images:

- `chenow9/umbrad` (includes `umbrad` and `umbra-visit`)
- `chenow9/umbra-node`

Pin production deployments to the current stable version, `0.3.0`, so a future `latest` update cannot change the running version unexpectedly.

**Gate** (Linux host networking):

```bash
UMBRA_TAG=0.3.0 docker compose -f deploy/compose.gate.yml up -d
# open the console (default bind is 127.0.0.1:8080)
# named volume umbra-tls → /var/lib/umbra holds certs, control.json, and traffic.
# Do not mount only ca.crt.
```

`deploy/compose.gate.yml` already sets `-advertise gate.example.com:4400`; change it to the address nodes can actually reach.

**Node** (host networking so services can target the host's `127.0.0.1`):

The enroll dialog's Docker command writes the CA locally and runs `docker run --network host`. Compose still works:

```bash
cp deploy/node.env.example node.env   # set UMBRA_SERVER / UMBRA_TOKEN
# copy the gate's ca.crt into the current directory
UMBRA_TAG=0.3.0 docker compose -f deploy/compose.node.yml up -d
```

Hot-replace the gateway binary without dropping tunnels:

```bash
kill -USR2 $(pidof umbrad)   # or: systemctl reload umbrad
```

Existing splices stay in the old process until they end; new accepts go to the new process.

## Network and ports

| Purpose                            | Default address            | Public exposure                                                              |
| ---------------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| Node / visitor client control and tunnels | `4400/TCP`                 | Required for sources that need to connect                                    |
| Separate UDP data plane            | `4400/UDP`                 | Used by `-udp auto/required`; `auto` can fall back to Yamux when unavailable |
| Web console and API                | `127.0.0.1:8080`           | Keep private; access through SSH forwarding or an HTTPS reverse proxy        |
| Public access / Temporary allow services          | User-defined               | Open the selected TCP or UDP ports as required                               |
| Ticket access services                 | No public service listener | Not required                                                                 |

## Platforms

|                              | amd64 | arm64 |
| ---------------------------- | ----- | ----- |
| Linux                        | ✓     | ✓     |
| macOS                        | ✓     | ✓     |
| Windows                      | ✓     | ✓     |
| Docker (linux, host network) | ✓     | ✓     |

Kernel DROP for Temporary allow is Linux-only. macOS / Windows gateways still close in user space. Docker gateway needs real host networking on a Linux host.

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

| Flag         | Default                | Role                                               |
| ------------ | ---------------------- | -------------------------------------------------- |
| `-listen`    | `:4400`                | node control channel                               |
| `-advertise` | empty (same as listen) | address written into install/visit commands        |
| `-http`      | `127.0.0.1:8080`       | console and API                                    |
| `-bind`      | `127.0.0.1`            | business-port bind; use `0.0.0.0` on a public gateway |
| `-tls-dir`   | `/var/lib/umbra`       | certs, state, `control.json`, `traffic`            |
| `-reset-2fa` | off                    | offline console 2FA reset (stop the daemon first)  |
| `-stealth`   | `auto`                 | `nft` / `off` / `auto`                             |
| `-udp`       | `auto`                 | UDP data plane: `auto` / `required` / `yamux`      |

Node: `--server`, `--token`, `--tls-ca`. The visitor client also needs `--ticket` and `--local`.

<a id="gate-authentication-capacity-and-udp-admission-environment-variables"></a>

### Gateway authentication, capacity, and UDP admission environment variables

`umbrad` reads these variables at startup, so restart or recreate the gateway container after changing them. They define gateway-wide defaults; each service's own `maxConns` limit still applies independently.

| Environment variable          | Default | Meaning                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UMBRA_2FA`                   |    `on` | Whether the console requires TOTP. Unset or `on` enables it; `off` disables it without deleting an existing binding; any other value refuses to start. `UMBRA_LOGIN=off`, `GROK_AGENT`, and `GROK_PROJECT_ID` skip all console auth (including 2FA) and are for preview only.                                                              |
| `UMBRA_MAX_SPLICES`           |  `8192` | Maximum number of active TCP forwarding connections (splices) across the entire gateway, shared by all TCP services and Ticket access forwarding. Effective concurrency is also limited by each service's `maxConns`. Only positive integers are accepted. Reaching the limit rejects new TCP forwarding without interrupting existing connections. |
| `UMBRA_UDP_MAX_FLOWS_PER_IP`  |   `256` | Maximum active UDP flows from one source IPv4 address within each service; IPv6 sources are grouped by `/64`. A UDP flow is identified by its source address and port and remains active until the UDP idle timeout. `0` disables this limit.                                                                                              |
| `UMBRA_UDP_NEW_FLOWS_PER_SEC` |   `256` | Maximum new UDP flows per second from one source IPv4 address within each service; IPv6 sources are grouped by `/64`. A token bucket permits bounded bursts. `0` disables this limit. This does not limit packet rate (pps) on established flows.                                                                                          |
| `UMBRA_UDP_NEW_FLOWS_PER_MAP` |  `1024` | Maximum aggregate new UDP flows per second for one service across all source addresses. A token bucket permits bounded bursts. `0` disables this limit. This does not limit packet rate (pps) on established flows.                                                                                                                        |

The total number of active UDP flows is still capped by the service's `maxConns`. A new flow must satisfy `maxConns`, the per-source active-flow limit, the per-source creation rate, and the per-service creation rate. Reaching any limit rejects that new flow without affecting established flows.

Override the defaults through the shell or a Compose `.env` file, for example:

```bash
UMBRA_MAX_SPLICES=16384 \
UMBRA_UDP_MAX_FLOWS_PER_IP=512 \
docker compose -f deploy/compose.gate.yml up -d
```

Before raising the TCP limit, verify file-descriptor limits and available memory on both the gateway and nodes. Disabling UDP admission protection increases the risk that one source consumes the flow quota or causes a resource-exhaustion attack.

### UDP socket receive-buffer environment variable

`umbrad`, `umbra-node`, and UDP visitor clients read the following variable when they start or create a UDP flow:

| Environment variable    |  Default | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UMBRA_UDP_READ_BUFFER` | `524288` | Requested receive-buffer size in bytes for every UDP socket, including the gateway's shared uplane and service sockets and node and visitor client uplane and local-target sockets. Only positive integers are accepted; an unset or invalid value uses 512 KiB. On Linux, the effective size is capped by the host's `net.core.rmem_max`. Restart the affected process or recreate its container after changing the value. The 512 KiB default is conservative for small 2-vCPU/2-GiB hosts and large UDP flow counts; explicitly raise it only after load testing burst requirements. |

Raise the Linux host limit to at least the requested size before increasing the variable, for example:

```bash
sysctl -w net.core.rmem_max=16777216
UMBRA_UDP_READ_BUFFER=8388608 docker compose -f deploy/compose.gate.yml up -d
```

A larger buffer absorbs bursts and scheduler stalls but does not replace sufficient sustained processing capacity. Use `ss -u -m` to inspect the effective socket `rb` and `Udp:RcvbufErrors` to detect receive-queue overflow.

### UDP loss diagnostics

The public gateway `/health` endpoint returns only the aggregate health state. Authenticated `/v1/health` and service APIs expose cumulative stage counters from the public socket through uplane and the client write-back. Set `UMBRA_UDP_STATS_INTERVAL` on a node to emit matching JSON statistics: `0` disables reporting (the default), while a positive integer is the reporting interval in seconds; `10` is recommended during a load test. Restart the node after changing it. Reports never include credentials, cookies, or keys.

## Security model and limitations

- Gateway ↔ Node control and tunnel traffic uses TLS 1.3 by default, and nodes must trust the gateway CA. Umbra does not automatically encrypt the client-facing protocol for Public access or Temporary allow; use SSH, HTTPS, or application-level encryption where required.
- Temporary allow (`spa`) authorizes a source IP after an authenticated action. It is not device or user identity. Other devices sharing the same public NAT address may establish new connections during the authorization window.
- An expired Temporary allow grant blocks new connections; it does not terminate established TCP connections or UDP flows that are still active. Temporary allow does not replace authentication in SSH, TLS, or the application itself.
- Kernel-level drops require Linux, nftables, and `CAP_NET_ADMIN`, and currently protect IPv4. Otherwise Umbra falls back to rejecting traffic in user space, where a service port may remain detectable. Kernel drops should be understood as scan resistance, not guaranteed invisibility.
- Access tickets are bearer credentials. Anyone holding a valid ticket can use it until it expires or is revoked, so transmit and store tickets securely.
- The management endpoint defaults to `127.0.0.1`. Non-loopback binds require TLS. When using a reverse proxy, trust only proxy addresses you control and configure `-http-trust-proxy` as described in [Reverse proxies and client IP addresses](#reverse-proxies-and-client-ip-addresses).
- Protect and back up the entire `-tls-dir`. It contains the CA private key, gateway certificate, administrator password hash, TOTP secret, node credentials, service settings, and traffic history. A leaked backup exposes the TOTP secret and enables offline password guessing; never commit or share it with an untrusted party.
- TOTP substantially reduces risk from password leaks, credential stuffing, and ordinary brute force, but it does not stop a real-time phishing proxy. Verify the console hostname and TLS before entering a code.
- New console services default to Ticket access (`visitor`); API clients that omit `mode` retain the `public` (Public access) default. Before Internet exposure, review the access mode, CIDR rules, target address, and the service's own authentication.

## Project and releases

- [Website](https://umbrad.grok.me)
- [GitHub Releases](https://github.com/chenow9/umbra/releases/latest)
- [Changelog](CHANGELOG.md)
- [Issue tracker](https://github.com/chenow9/umbra/issues)
- Docker Hub: [`chenow9/umbrad`](https://hub.docker.com/r/chenow9/umbrad) · [`chenow9/umbra-node`](https://hub.docker.com/r/chenow9/umbra-node)

## Related Projects

- [MoonProxy](https://github.com/MoonProxyHQ/moonproxy-desktop) — A cross-platform desktop GUI client for frp, built for non-technical users, with visual configuration and connection management. Works with an frps server.
- [Lantunnel](https://github.com/lantunnel/lantunnel) — A P2P-first, end-to-end encrypted private networking tool written in Rust, with direct peer connections and encrypted relay fallback, without port forwarding.

## License

Apache License 2.0. See [LICENSE](LICENSE).
