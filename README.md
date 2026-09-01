# umbra

[English](README.en.md)

自托管 **L4（TCP / UDP）** 隐匿内网穿透网关。  
节点只带入口地址和凭证；映射、模式、ACL 全部在服务端改，热下发，不改客户端文件、不重启入口、不断已有连接。

## 它解决什么

把内网里的 TCP / UDP 服务，经一台自托管入口暴露出去，同时让扫描默认看不见业务口。

1. 只做 L4：TCP、UDP，不做用户流量的 L7 反代。
2. **配置唯一真相在服务端。** 节点只带入口地址和凭证；映射、模式、ACL 在控制台改完即热下发，不必再登录节点改文件。
3. 入口运行时绑定 / 释放端口，其它映射的在途连接不受影响。换入口程序发 USR2，已有隧道留在旧进程直到结束。
4. 三种映射模式：`public`（公开访问，新建默认）、`spa`（敲门访问）、`visitor`（入口不监听业务口，访问侧用票据开本机 L4）。
5. 按节点、按映射看实时速率和累计流量；控制台与 API 共用一个 HTTP 口，第一次打开设定口令。

## 组成

| 程序 | 作用 |
|---|---|
| `umbrad` | 公网入口。TLS 1.3 控制通道、业务口 Listen、`spa` 内核丢弃、热升级、控制台 |
| `umbra-node` | NAT 后节点。只连入口，按服务端下发的映射去拨本地目标 |
| `umbra-visit` | 访问端。用服务端签发的票据在本机开一个 L4 口（TCP/UDP），入口不暴露业务端口 |
| 控制台 | 总览 / 节点 / 映射 / 流量 / 审计 / 部署。与 API 共用一个 HTTP 口，第一次打开时设定口令 |

## 映射模式

控制台和 API 用这三个标识（括号里是界面上的说明）：

| 模式 | 入口业务口 | 访问方式 |
|---|---|---|
| `spa`（敲门访问） | 有。未敲门的来源在 Linux 入口用 nftables 丢掉（需 `CAP_NET_ADMIN`）；没有权限时退回用户态断开。控制台「敲门」按来源 IP 放行，默认窗口 60 秒，只限制新建。 | 先敲门，再连入口端口 |
| `visitor`（加密隧道访问） | 无。入口不监听业务口。 | 签发票据（`umbra_vis_…`，24 小时）后，在访问侧跑 `umbra-visit`，本机开 L4 |
| `public`（公开访问） | 有。对扫描可见，任何人（可再加 CIDR 白名单）可连。 | 直接连入口端口，例如游戏 UDP |

新建映射默认 `public`。需要隐蔽时再选 `spa`。

## 快速开始

**1. 编入口、节点、访问端**

```bash
# go.mod：Go 1.25（toolchain 1.25.14）
./scripts/build-binaries.sh
# 产物在 dist/：linux / darwin / windows × amd64 / arm64
```

**2. 跑入口**

```bash
sudo ./dist/umbrad_linux_amd64 \
  -listen :4400 \
  -advertise gate.example.com:4400 \
  -http 127.0.0.1:8080 \
  -bind 0.0.0.0 \
  -tls-dir /var/lib/umbra
```

首次启动会在 `-tls-dir` 写出 `ca.crt` / `gate.crt` / `gate.key`。  
`-advertise` 填节点和访客实际能连接的入口地址；它只用于生成部署与访客命令，不改变监听地址。

`-tls-dir` 还会陆续写入：

- `control.json`：口令、登录会话、节点凭证、映射（含累计字节）
- `traffic`：速率曲线采样（约每 10 秒写一次）
- `state.json`：热升级时的恢复状态

**3. 登记节点**

在控制台「节点 → 登记节点」签发凭证（`umbra_boot_…`，只显示一次）。弹窗里有本机安装命令和 Docker 命令，入口 CA 已写进命令，不必再单独 scp `ca.crt`。

手动等价：

```bash
./umbra-node \
  --server gate.example.com:4400 \
  --tls-ca /etc/umbra/ca.crt \
  --token umbra_boot_…
```

节点凭证默认 90 天，也可按节点设为永不过期；过期前轮换，或随时吊销。轮换后旧凭证大约 90 秒内仍可用。

### 节点系统服务管理

控制台生成的二进制安装命令会把 `umbra-node` 注册为系统服务。命令执行完成后可以关闭终端；节点会继续运行，并随系统启动自动上线。

**Linux（systemd）**

```bash
# 查看状态和最近日志
sudo systemctl status umbra-node
sudo journalctl -u umbra-node -n 100 --no-pager

# 临时停止；下次开机仍会自动启动
sudo systemctl stop umbra-node

# 启动或重启
sudo systemctl start umbra-node
sudo systemctl restart umbra-node

# 停止并禁用开机启动
sudo systemctl disable --now umbra-node

# 恢复开机启动并立即运行
sudo systemctl enable --now umbra-node
```

彻底卸载 Linux 服务：

```bash
sudo systemctl disable --now umbra-node
sudo rm -f /etc/systemd/system/umbra-node.service
sudo systemctl daemon-reload
sudo rm -f /usr/local/bin/umbra-node
```

**macOS（launchd）**

```bash
# 查看状态
sudo launchctl print system/io.umbra.node

# 临时停止；下次开机仍会自动启动
sudo launchctl bootout system/io.umbra.node

# 再次启动
sudo launchctl bootstrap system /Library/LaunchDaemons/io.umbra.node.plist

# 重启
sudo launchctl kickstart -k system/io.umbra.node

# 停止并禁用开机启动
sudo launchctl bootout system/io.umbra.node 2>/dev/null || true
sudo launchctl disable system/io.umbra.node

# 恢复开机启动并立即运行
sudo launchctl enable system/io.umbra.node
sudo launchctl bootstrap system /Library/LaunchDaemons/io.umbra.node.plist
```

彻底卸载 macOS 服务：

```bash
sudo launchctl bootout system/io.umbra.node 2>/dev/null || true
sudo launchctl disable system/io.umbra.node
sudo rm -f /Library/LaunchDaemons/io.umbra.node.plist
sudo rm -f /usr/local/libexec/umbra-node-run
sudo rm -f /usr/local/bin/umbra-node
```

**Windows（管理员 PowerShell）**

```powershell
# 查看状态
Get-Service -Name UmbraNode

# 临时停止；下次开机仍会自动启动
Stop-Service -Name UmbraNode

# 启动或重启
Start-Service -Name UmbraNode
Restart-Service -Name UmbraNode

# 停止并禁用开机启动
Stop-Service -Name UmbraNode -ErrorAction SilentlyContinue
Set-Service -Name UmbraNode -StartupType Disabled

# 恢复开机启动并立即运行
Set-Service -Name UmbraNode -StartupType Automatic
Start-Service -Name UmbraNode
```

彻底卸载 Windows 服务：

```powershell
Stop-Service -Name UmbraNode -ErrorAction SilentlyContinue
sc.exe delete UmbraNode
```

卸载系统服务默认保留 CA 和本地配置，方便重新安装。确认不再使用该节点时，先在控制台吊销节点凭证，再按需删除 `/etc/umbra`、`/usr/local/etc/umbra` 或 `C:\ProgramData\Umbra`；删除本地文件不会自动删除控制台中的节点记录。

**4. 控制台**

`umbrad -http` 同时提供 API 和静态页面，默认 `127.0.0.1:8080`。第一次打开设定口令。

开发时 Vite 只是把 `/v1` 反代到入口进程。生产把前端构建产物放到 `-ui`，或用 nginx 反代同一个口。

在控制台增删映射即可，不必登录节点改任何文件。Linux systemd、macOS launchd、Windows 服务、Docker 示例见控制台「部署」页。

管理口默认只绑回环。绑到非回环地址必须加 `-http-tls-cert` / `-http-tls-key`（或 `-http-tls` 复用 tls-dir 证书），否则拒绝启动。不要裸 HTTP 上公网。

**5. 访问端（仅 `visitor`）**

在需要访问内网服务的电脑上安装对应平台的 `umbra-visit`。在控制台「映射」中对 `visitor` 映射选择「签发」，然后执行只显示一次的命令：

```bash
umbra-visit --server gate.example.com:4400 \
  --tls-ca /etc/umbra/ca.crt \
  --ticket umbra_vis_… \
  --local 127.0.0.1:2222
```

随后业务客户端连接 `127.0.0.1:2222`。`umbra-visit` 是访问侧按需运行的进程，不要装在入口或内网节点上；停止进程即关闭这个本机访问口。各平台安装命令见控制台「部署 → 访问端 umbra-visit」。入口镜像 `chenow9/umbrad` 里已带 `umbra-visit`。

## Docker（公网入口 + 内网节点）

入口容器就是控制面：`-http` 同时提供网页和 API（默认 `127.0.0.1:8080`），节点走 `:4400` TLS。镜像构建时会把控制台打进 `umbrad`，第一次打开网页设定口令。不要再单独跑 `npm run dev`。

Docker Hub 提供 **linux/amd64** 和 **linux/arm64** 镜像：

- `chenow9/umbrad`（含 `umbrad` 与 `umbra-visit`）
- `chenow9/umbra-node`

生产环境建议固定使用当前正式版本 `0.1.3`，避免 `latest` 更新后意外改变运行版本。

**入口**（Linux 宿主机，host 网络）：

```bash
UMBRA_TAG=0.1.3 docker compose -f deploy/compose.gate.yml up -d
# 浏览器打开入口的控制台（默认只绑 127.0.0.1:8080）
# named volume umbra-tls → /var/lib/umbra
# 里面是证书、control.json、traffic。不要只挂 ca.crt。
```

`deploy/compose.gate.yml` 里已带 `-advertise gate.example.com:4400`，部署时改成节点真正能连上的地址。

**节点**（同样 host 网络，才能把映射目标写成宿主机 `127.0.0.1`）：

控制台登记弹窗的 Docker 命令会把 CA 写进本机再 `docker run --network host`。也可以用 compose：

```bash
cp deploy/node.env.example node.env   # 填 UMBRA_SERVER / UMBRA_TOKEN
# 把入口的 ca.crt 放到当前目录
UMBRA_TAG=0.1.3 docker compose -f deploy/compose.node.yml up -d
```

换入口程序本身不停机：

```bash
kill -USR2 $(pidof umbrad)   # 或 systemctl reload umbrad
```

已有隧道留在旧进程直到结束；新连接由新进程接管。

## 平台

| | amd64 | arm64 |
|---|---|---|
| Linux | ✓ | ✓ |
| macOS | ✓ | ✓ |
| Windows | ✓ | ✓ |
| Docker（linux，host 网络） | ✓ | ✓ |

`spa` 的内核丢弃仅 Linux。macOS / Windows 入口仍是用户态断开。Docker 入口需要 Linux 宿主机的 host 网络。

## 仓库结构

```
cmd/umbrad          入口
cmd/umbra-node      节点
cmd/umbra-visit     访问端（本机 L4）
internal/           控制通道、策略、nftables、TLS、热升级、控制面 HTTP
src/                管理面（React；生产由 umbrad -http / -ui 提供）
scripts/            交叉编译与冒烟
deploy/             入口 / 节点 Docker Compose
.github/workflows   CI：vet / test / race / govulncheck；tag 才推镜像，且必须先过 CI
```

常用入口参数（`umbrad -h`）：

| 参数 | 默认 | 作用 |
|---|---|---|
| `-listen` | `:4400` | 节点控制通道 |
| `-advertise` | 空（沿用 listen） | 写进部署/访客命令的对外地址 |
| `-http` | `127.0.0.1:8080` | 控制台与 API |
| `-bind` | `127.0.0.1` | 业务口监听地址；公网入口用 `0.0.0.0` |
| `-tls-dir` | `/var/lib/umbra` | 证书、状态、`control.json`、`traffic` |
| `-stealth` | `auto` | `nft` / `off` / `auto` |
| `-udp` | `auto` | UDP 数据面：`auto` / `required` / `yamux` |

节点：`--server`、`--token`、`--tls-ca`。访问端另加 `--ticket`、`--local`。

### 入口容量与 UDP 准入环境变量

这些变量由 `umbrad` 在启动时读取，修改后需要重启或重建入口容器。它们是入口级默认策略；映射自身的 `maxConns` 仍会独立生效。

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `UMBRA_MAX_SPLICES` | `8192` | 整个入口允许同时存在的 TCP 转发连接（splice）总数，所有 TCP 映射和访客转发共享。实际可用并发还受各映射 `maxConns` 限制；只接受大于 `0` 的整数。达到上限后拒绝新的 TCP 转发，不中断已有连接。 |
| `UMBRA_UDP_MAX_FLOWS_PER_IP` | `256` | 每个映射内，同一来源 IPv4（IPv6 按 `/64` 聚合）允许同时存在的 UDP flow 数。UDP flow 由来源地址和端口标识，并保持到 UDP 空闲超时；`0` 表示关闭此限制。 |
| `UMBRA_UDP_NEW_FLOWS_PER_SEC` | `256` | 每个映射内，每个来源 IPv4（IPv6 按 `/64` 聚合）每秒允许新建的 UDP flow 数，采用令牌桶限制突发建流；`0` 表示关闭此限制。它不限制已有 flow 的 UDP 包速率（pps）。 |
| `UMBRA_UDP_NEW_FLOWS_PER_MAP` | `1024` | 单个映射每秒允许新建的 UDP flow 总数，所有来源地址合计，采用令牌桶限制突发建流；`0` 表示关闭此限制。它不限制已有 flow 的 UDP 包速率（pps）。 |

UDP 的活动 flow 总数仍受映射 `maxConns` 限制。新 flow 必须同时满足 `maxConns`、单来源活动 flow 上限、单来源建流速率和单映射建流速率；任何一项达到上限都会拒绝该新 flow，已有 flow 不受影响。

Docker Compose 可通过 shell 或 Compose 的 `.env` 文件覆盖默认值，例如：

```bash
UMBRA_MAX_SPLICES=16384 \
UMBRA_UDP_MAX_FLOWS_PER_IP=512 \
docker compose -f deploy/compose.gate.yml up -d
```

提高 TCP 上限前，应同时检查入口和节点的文件描述符上限及可用内存。关闭 UDP 准入保护会增加来源地址耗尽 flow 配额或触发资源消耗型攻击的风险。

### UDP socket 接收缓冲环境变量

`umbrad`、`umbra-node` 和 UDP visitor 都会在启动或创建 UDP flow 时读取以下变量：

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `UMBRA_UDP_READ_BUFFER` | `524288` | 每个 UDP socket 请求的接收缓冲区字节数，覆盖 gate 的共享 uplane socket、业务映射 socket、node/visitor 的 uplane socket 及其本地目标 socket。只接受大于 `0` 的整数；未设置或无效时使用 512 KiB。Linux 实际值受宿主机 `net.core.rmem_max` 限制，修改后需要重启相应进程或重建容器。512 KiB 是兼顾 2C2G 小型服务器和大量 UDP flow 的保守默认值；高突发场景应在压测后显式调大。 |

在 Linux 上提高该值前，需先把宿主机的 `net.core.rmem_max` 调整到不低于请求值，例如：

```bash
sysctl -w net.core.rmem_max=16777216
UMBRA_UDP_READ_BUFFER=8388608 docker compose -f deploy/compose.gate.yml up -d
```

较大的缓冲区可以吸收突发流量和调度停顿，但不能替代足够的持续处理能力。可通过 `ss -u -m` 查看 socket 的实际 `rb`，并通过 `Udp:RcvbufErrors` 判断是否仍发生接收队列溢出。

### UDP 丢包诊断

入口的 `/health` 和映射 API 提供从业务端口、uplane 到客户端回写的分段累计计数。节点可设置 `UMBRA_UDP_STATS_INTERVAL` 输出对应的 JSON 统计日志：默认 `0`（关闭），设置为大于 `0` 的整数时表示输出间隔秒数，压测时建议 `10`。修改后需重启节点；统计日志不包含凭证、cookie 或密钥。

## 安全注意

- 控制通道默认 TLS 1.3，节点必须带 `--tls-ca`。新签发的 CA 主题是 `umbra CA`（已有 tls-dir 不会改写）。
- 发布镜像用 Go 1.25.14（digest 钉死）。推 `v*` tag 会先跑 vet、`-race` 测试和 govulncheck，失败不推镜像。
- 管理面默认 `127.0.0.1`；非回环必须 TLS。
- 节点凭证默认 90 天，可永不过期；访客票据 24 小时。凭证只显示一次，吊销在控制台操作。
- `spa` 要对 nmap 显示 filtered，入口进程需要 `CAP_NET_ADMIN`。
- 映射目标默认仅本机或 RFC1918。
