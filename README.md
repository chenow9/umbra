# umbra

[English](README.en.md)

自托管 **L4（TCP / UDP）** 隐匿内网穿透网关。  
节点只带入口地址和凭证；映射、模式、ACL 全部在服务端改，热下发，不改客户端文件、不重启入口、不断已有连接。

## 它解决什么

把内网里的 TCP / UDP 服务，经一台自托管入口暴露出去，同时让扫描默认看不见业务口。

1. 只做 L4：TCP、UDP，不做用户流量的 L7 反代。
2. **配置唯一真相在服务端。** 节点只带入口地址和凭证；映射、模式、ACL 在控制台改完即热下发，不必再登录节点改文件。
3. 入口运行时绑定 / 释放端口，其它映射的在途连接不受影响。换入口程序发 USR2，已有隧道留在旧进程直到结束。
4. 三种映射模式：`spa`（敲门访问，新建默认）、`visitor`（入口不监听业务口，访问侧用票据开本机 L4）、`public`（显式打开的业务口）。
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

新建映射默认 `spa`。`public` 必须显式选。

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

推送符合 semver 的 tag（`v1.2.3`）会构建 **linux/amd64** 和 **linux/arm64** 镜像并推到 Docker Hub：

- `chenow9/umbrad`（含 `umbrad` 与 `umbra-visit`）
- `chenow9/umbra-node`

标签：`1.2.3`、`1.2`；不含 `-` 的正式版才打 `latest`。预发布例如 `v0.0.1-beta` 只会推 `0.0.1-beta`。

```bash
git tag v0.1.0
git push origin v0.1.0
```

**入口**（Linux 宿主机，host 网络）：

```bash
UMBRA_TAG=0.0.1-beta docker compose -f deploy/compose.gate.yml up -d
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
UMBRA_TAG=0.0.1-beta docker compose -f deploy/compose.node.yml up -d
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

## 安全注意

- 控制通道默认 TLS 1.3，节点必须带 `--tls-ca`。新签发的 CA 主题是 `umbra CA`（已有 tls-dir 不会改写）。
- 发布镜像用 Go 1.25.14（digest 钉死）。推 `v*` tag 会先跑 vet、`-race` 测试和 govulncheck，失败不推镜像。
- 管理面默认 `127.0.0.1`；非回环必须 TLS。
- 节点凭证默认 90 天，可永不过期；访客票据 24 小时。凭证只显示一次，吊销在控制台操作。
- `spa` 要对 nmap 显示 filtered，入口进程需要 `CAP_NET_ADMIN`。
- 映射目标默认仅本机或 RFC1918。
