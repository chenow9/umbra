# 幽门 Umbra

[English](README.en.md) · [中文](#幽门) · [需求文档](docs/幽门-L4隐匿穿透-需求分析与技术报告.md) · [接口草案](docs/M1-接口草案.md)

自托管 **L4（TCP / UDP）** 隐匿内网穿透网关。  
节点只带入口地址和凭证；映射、模式、ACL 全部在服务端改，热下发，不改客户端文件、不重启入口、不断已有连接。

---

## 幽门

### 它解决什么

NPS 的控制模型是对的（服务端改完客户端立刻执行），但停更、CVE 太多。  
Pangolin 做 TCP/UDP 要改 Traefik 并重启。Orbien 要先把端口池映射进容器。frp 的配置真相在客户端 toml。

幽门只要五件事叠在一起：

1. 只做 L4：TCP、UDP，不做用户流量的 L7 反代。
2. **配置唯一真相在服务端。** 节点安装后不再改配置。
3. 入口运行时绑定 / 释放端口，其它映射的在途连接不受影响。
4. 默认对扫描不可见（暗端口 / SPA / Visitor）；公开口是显式选项。
5. 按节点、按映射的流量统计 + 简约管理面。

不提供：把 `frpc.toml` 当产品配置面、兼容 NPS 协议、互联网登录体系。

### 组成

| 程序 | 作用 |
|---|---|
| `umbrad` | 公网入口。控制通道（TLS 1.3）、业务口 Listen、SPA 内核丢弃、热升级 |
| `umbra-agent` | NAT 后节点。只连入口，按服务端下发的映射去拨本地目标 |
| 控制台 | 总览 / 节点 / 映射 / 流量 / 审计 / 部署。与 API 共用一个 HTTP 口，第一次打开时设定口令 |

### 模式

- **暗端口（SPA）**：未敲门的包在 Linux 入口用 nftables 丢掉（需 `CAP_NET_ADMIN`）。没有权限时退回用户态断开。
- **公开**：显式打开的业务口（例如游戏 UDP）。
- **Visitor**：入口不开业务口，由访客票据从内网向外连。

### 快速开始

**1. 编入口和节点程序**

```bash
go 1.24+
./scripts/build-binaries.sh
# 产物在 dist/：linux / darwin / windows × amd64 / arm64
```

**2. 跑入口**

```bash
sudo ./dist/umbrad_linux_amd64 \
  -listen :4400 \
  -http :8080 \
  -bind 0.0.0.0 \
  -tls-dir /var/lib/umbra
```

首次启动会在 `-tls-dir` 写出 `ca.crt` / `gate.crt` / `gate.key`。把 `ca.crt` 拷到节点所在机器。

**3. 登记节点（控制台「登记节点」签发凭证，只显示一次）**

```bash
./umbra-agent \
  --server gate.example:4400 \
  --tls-ca /etc/umbra/ca.crt \
  --token umbra_boot_…
```

**4. 控制台**

`umbrad -http` 同时提供 API 和静态页面，默认 `:8080`。第一次打开设定口令。

开发时 Vite 只是把 `/v1` 反代到入口进程，生产把前端构建产物放到 `-ui`，或用 nginx 反代同一个口。

在控制台增删映射即可，不必登录节点改任何文件。Linux 安装单元、macOS launchd、Windows 服务、Docker compose 见控制台「部署」页。

### Docker（公网入口 + 内网节点）

入口容器就是控制面：`-http` 同时提供网页和 API（默认 `:8080`），节点走 `:4400` TLS。镜像构建时会把控制台打进 `umbrad`，第一次打开网页设定口令。不要再单独跑 `npm run dev`。

推送符合 semver 的 tag（`v1.2.3`）会构建 **linux/amd64** 和 **linux/arm64** 镜像并推到 Docker Hub：

- `chenow9/umbrad`
- `chenow9/umbra-agent`

标签：`1.2.3`、`1.2`；不含 `-` 的正式版才打 `latest`。预发布例如 `v0.0.1-beta` 只会推 `0.0.1-beta`。

```bash
git tag v0.1.0
git push origin v0.1.0
```

**入口**（Linux 宿主机，host 网络）：

```bash
UMBRA_TAG=0.0.1-beta docker compose -f deploy/compose.gate.yml up -d
# 浏览器打开 http://入口:8080 ，第一次设定口令
# 证书在 named volume umbra-tls → /var/lib/umbra/ca.crt
```

`-http :8080` 不要裸奔公网；可改成 `127.0.0.1:8080`，再用 SSH 隧道访问。

**节点**（同样 host 网络，才能把映射目标写成宿主机 `127.0.0.1`）：

```bash
cp deploy/agent.env.example agent.env   # 填 UMBRA_SERVER / UMBRA_TOKEN
# 把入口的 ca.crt 放到当前目录
UMBRA_TAG=0.0.1-beta docker compose -f deploy/compose.agent.yml up -d
```

换入口程序本身不停机：

```bash
kill -USR2 $(pidof umbrad)   # 或 systemctl reload umbrad
```

已有隧道留在旧进程直到结束；新连接由新进程接管。

### 平台

| | amd64 | arm64 |
|---|---|---|
| Linux | ✓ | ✓ |
| macOS | ✓ | ✓ |
| Windows | ✓ | ✓ |
| Docker（linux，host 网络） | ✓ | ✓ |

内核丢弃仅 Linux。macOS / Windows 入口仍是用户态断开。Docker 入口需要 Linux 宿主机的 host 网络。

### 仓库结构

```
cmd/umbrad          入口
cmd/umbra-agent     节点程序
internal/           控制通道、策略、nftables、TLS、热升级、控制面 HTTP
src/                管理面（React；生产由 umbrad -http / -ui 提供）
docs/               需求与接口
scripts/            交叉编译与冒烟
deploy/             入口 / 节点 Docker Compose
.github/workflows   tag 触发多架构镜像
```

### 安全注意

- 控制通道默认 TLS 1.3，节点必须带 `--tls-ca`。
- 管理面只放在你自己够得到的网上，不要裸奔公网。
- 暗端口要对 nmap 显示 filtered，入口进程需要 `CAP_NET_ADMIN`。
- 凭证只显示一次，吊销在控制台操作。

---

## Umbra

Self-hosted **L4 (TCP/UDP)** stealth tunnel. The server is the only source of truth: Agents carry an address and a credential; mappings are pushed live. No client config files, no gate restart, no dropped existing connections.

Full English: [README.en.md](README.en.md).
