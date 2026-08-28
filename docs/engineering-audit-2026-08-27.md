# Umbra L4 内网穿透工程审计

审计日期：2026-08-27  
审计对象：当前工作树，而不是仅审计 Git HEAD  
基线提交：d2fecbc（工作树存在大量已修改、重命名和未跟踪文件）  
审计性质：源码静态审计、依赖漏洞扫描、现有测试验证、竞品官方源码/文档核对；未执行跨主机容量压测

## 0. 结论摘要

结论：当前实现适合原型验证、可信小规模内网和功能演示，不应直接作为暴露在公网、接受恶意客户端或恶意流量的生产级网络基础设施。

阻止生产上线的核心原因不是“功能比 frp 少”，而是以下安全与生命周期不变量尚未建立：

1. [Confirmed] 公网控制端口在身份认证前就创建 yamux session，且首流/首帧无截止时间。单个未认证连接可以建立最多 256 个未被业务层消费的 stream，并让服务端为每个 stream 缓冲最多 256 KiB，理论上形成约 64 MiB/连接的预认证内存放大。
2. [Confirmed] 撤销 node 只关闭当前 session，没有从 gate.tok 删除旧 token。旧 token 可立即重放；热升级 Snapshot 还会继续保存并恢复该 token。
3. [Confirmed] 双向复制在一个方向 EOF/超时后仍等待另一个方向，之后才关闭两端。对安静的 SSH、数据库或自定义长连接，公开侧 idle timeout 不能真正回收 stream、FD、goroutine 和 active 配额。
4. [Confirmed] 管理控制台默认监听 :8080 裸 HTTP；官方 compose 使用 host network 并保持该监听。口令、会话 cookie、bootstrap token、visitor ticket 都可能被同链路攻击者读取或篡改。
5. [Confirmed] HTTP Server 没有 ReadHeaderTimeout、ReadTimeout、WriteTimeout、IdleTimeout、MaxHeaderBytes 或请求体上限；登录还在全局控制锁内执行 scrypt，容易被慢连接、超大 body 和认证请求拖住。
6. [Confirmed] MaxConns 的“检查—开流—递增”不是原子操作，公网突发并发可越过限制；系统也没有全局连接、FD、stream、goroutine、每 IP 或每 node 配额。
7. [Confirmed] control.json 非原子覆盖写且忽略错误；解析失败被当作“未配置 owner”。磁盘截断或损坏会同时丢失配置，并重新开放首次 setup 抢占面。
8. [Confirmed] 所有映射无严格输入验证；Unix 监听器无条件启用 SO_REUSEPORT。两个映射可以绑定同一端口，流量由内核随机分给不同 mapping/node。
9. [Confirmed] UDP 被封装到可靠 TCP/yamux stream 上，存在跨所有 stream 的 TCP head-of-line blocking；每个活跃流又有独立的定时器和分配，无法保持原生 UDP 的丢包/乱序语义。
10. [Confirmed] 单进程、单机内存状态、单物理 tunnel/session、无共享状态和无会话迁移；所谓热升级会让新旧 SO_REUSEPORT listener 同时收流，但新进程没有旧 agent session，不能实现零中断接管。

未发现自研加密算法。默认 node/visitor 通道使用 TLS 1.3 并校验私有 CA，这是当前实现的明显优点；长度帧也在分配前检查了 1 MiB/64 KiB 上限。问题在于这些局部防线尚不足以构成生产安全边界。

标记约定：

- [Confirmed]：可以从当前源码或执行结果直接证明。
- [Hypothesis]：从实现推导出的高概率结果，需要 profiling、抓包或故障注入量化。
- [Needs Verification]：当前环境或证据不足，不能下确定结论。

## 1. 范围、方法与验证结果

### 1.1 实际审计范围

核心 Go 实现约 4.6 KLOC，实际运行路径是：

- umbrad：cmd/umbrad/main.go
- node/agent：cmd/umbra-node/main.go、internal/node/node.go
- visitor：cmd/umbra-visit/main.go、internal/visit/visit.go
- gate/relay：internal/gate/gate.go、internal/gate/gate_visit.go
- Go 控制面/API：internal/control/control.go、internal/control/http.go
- 协议与转发：internal/wire/wire.go、internal/xfer/xfer.go、internal/muxcfg/muxcfg.go
- TLS、ACL、socket、stealth：internal/tlscfg、internal/policy、internal/netutil、internal/stealth
- UI：src/components、src/routes、src/lib/umbra/api.ts

src/lib/umbra/actions.ts、数据库 migrations 和部分 TypeScript 控制逻辑不是当前嵌入式生产 UI 的主调用路径。UI 直接通过 src/lib/umbra/api.ts 调 Go 的 /v1 API；Dockerfile 执行 build:embed-ui 后把产物复制到 internal/control/ui，再由 Go embed。

### 1.2 执行验证

- [Confirmed] go test -race ./...：通过。
- [Confirmed] go vet ./...：通过。
- 限制：Go 测试主要覆盖 wire/xfer 和 TCP、UDP、visitor 三条 happy-path 集成流；没有恶意协议、断流、半关闭、撤销、限额竞态、热升级、10k 连接或 fuzz 测试。
- [Confirmed] npm test：195 项中 177 通过、18 失败；部分失败来自缺失 .grok 模板资产和环境假设，也有认证环境/migration 计划不一致。
- [Confirmed] npm run typecheck：失败，包括 deploy-page.tsx 和 actions.ts 多个未定义 node，以及缺失 owner.server 模块。
- [Confirmed] govulncheck 对本机 go1.25.11 找到 5 个符号级可达标准库漏洞：GO-2026-6090、6089、5972、5856、5026；均可通过升级到至少 Go 1.25.13 修复。另有 2 个 imported-package 和 21 个 required-module 命中，但扫描器没有找到当前代码调用路径。
- [Needs Verification] Dockerfile 使用浮动 golang:1.24-bookworm，最终生产镜像实际包含哪个补丁版本取决于构建时间；本机扫描结果不能直接等同于已发布镜像。
- [Needs Verification] npm audit 未完成：当前 npm 镜像不实现 audit API，官方 registry 请求又发生 socket hang up。

## 2. 架构理解

### 2.1 角色与边界

| 角色 | 实现位置 | 责任 |
|---|---|---|
| Public Server / Gate / Relay | cmd/umbrad/main.go；internal/gate/gate.go | 接受 node/visitor tunnel，动态监听公开 TCP/UDP 端口，在 tunnel 与公网 socket 间转发 |
| Control Plane | internal/control/control.go；internal/control/http.go | owner 登录、node/token、mapping、ticket、流量样本、审计、持久化 |
| Node / Agent | cmd/umbra-node/main.go；internal/node/node.go | 从内网主动连接 gate，接收 mapping，连接 LocalHost:LocalPort |
| Visitor | cmd/umbra-visit/main.go；internal/visit/visit.go | 使用 ticket 建立受限 tunnel，并在本机开放一个访问端口 |
| Relay | 没有独立进程 | gate 本身就是 relay；visitor 与 node 的流量也经 gate 中继 |
| UI | src/...；internal/control/ui | React SPA，调用 Go /v1 API |

当前没有独立的调度器、共享存储、证书签发服务、指标服务或多租户身份服务。

### 2.2 控制面

控制面有两层：

1. 管理 HTTP 控制面  
   cmd/umbrad/main.go:73、83-106 创建裸 HTTP listener 和 control.Console。internal/control/http.go:25-68 注册 /v1 API；cookie 鉴权在 112-129；状态保存在 internal/control/control.go 的内存 map，并写入 control.json。

2. node/visitor 隧道控制面  
   cmd/umbrad/main.go:62-68 在 :4400 上创建 TCP/TLS listener。internal/gate/gate.go:111-146 为每个连接创建 yamux session，接受第一个 stream，读取长度前缀 JSON Envelope。Enroll/Hello/MappingSync/MappingAck/Visit 都走该 control stream。

没有明确的协议版本协商、capability negotiation、control-plane 队列上限、全局 admission controller 或幂等配置版本。

### 2.3 TCP tunnel 建立完整流程

#### Node 注册

1. node 在 internal/node/node.go:23-36 通过 TCP 连接 gate，并可选执行 TLS handshake。
2. node 在 39-49 创建 yamux client 并打开第一个 control stream。
3. node 在 51-59 发送 Enroll，body 包含长期 bootstrap token、主机和版本信息。
4. gate 在 internal/gate/gate.go:121-145 创建 yamux server、接受首 stream、读取首 Envelope。
5. gate 在 169-203 用 gate.tok 的明文 map 验证 token，创建 nodeConn；相同 node ID 的旧 session 被关闭，“最后连接者获胜”。
6. node 收到 EnrollOk 后在 internal/node/node.go:162-170 发送 Hello。
7. gate 在 internal/gate/gate.go:204-229 将 node 标为 online 并发送当前 mappings。
8. node 在 internal/node/node.go:170-198 更新本地 mapping map 并发送 MappingAck。gate 在 internal/gate/gate.go:230 直接忽略 Ack。

#### Public TCP 数据连接

~~~text
Public User
  │ TCP accept
  ▼
Gate mapping listener
  internal/gate/gate.go:509 serveTCP
  internal/gate/gate.go:519 handleTCP
  │ ACL / SPA / MaxConns
  │ yamux.Session.OpenStream
  │ StreamOpen(JSON frame)
  ▼
TLS 1.3 TCP tunnel + yamux
  │ one physical session per node
  ▼
Node
  internal/node/node.go:76 acceptStreams
  internal/node/node.go:86 handleStream
  │ mapping lookup
  │ net.DialTimeout(LocalHost:LocalPort)
  ▼
Internal Service
~~~

建立数据流的具体步骤：

1. mapping 创建时，gate.ensureEntry 在 internal/gate/gate.go:412-477 动态绑定 entry port。
2. public 连接由 serveTCP 接受；每个连接新建 goroutine。
3. handleTCP 执行 SPA、CIDR 和 MaxConns 检查，查找 node session。
4. gate 调 sess.OpenStream，并用 wire.WriteOpen 写入 MappingID、Proto、PeerIP、PeerPort、Via。
5. node.acceptStreams 接受 stream；handleStream 在 8 秒 header deadline 内解析 StreamOpen。
6. node 只允许已经由 gate 下发、Enabled 的 MappingID，然后连接配置中的 LocalHost:LocalPort。
7. gate 和 node 两端都调用 xfer.CopyBidirectional；每端各有两个 io.Copy goroutine。

内部服务看不到真实 public source IP；PeerIP 只存在 StreamOpen 元数据中，没有 PROXY protocol 或透明代理注入。

### 2.4 UDP 数据路径

~~~text
Public UDP client
  │ datagram
  ▼
Gate PacketConn / udp4
  internal/gate/gate.go:582 serveUDP
  │ key = source IP:port
  │ one yamux stream per source
  │ 4-byte length + payload
  ▼
TLS-over-TCP + yamux stream
  ▼
Node relayUDP
  internal/node/node.go:116
  │ connected UDP socket
  ▼
Internal UDP service
~~~

- gate 为每个 source IP:port 建立一个 udpSess 和 yamux stream。
- UDP payload 使用 wire.WriteDatagram/ReadDatagram 的 4 字节大端长度帧。
- node 为每个 stream 创建一个 connected UDP socket；两个 goroutine 双向转发。
- 返回路径反向执行。
- visitor UDP 多一段 visitor yamux：visitor → gate visitor session → gate node session → node UDP。

[Confirmed] UDP 在可靠 TCP 上运行；任一底层 TCP 丢包都会阻塞该连接上所有 yamux stream，而不只是丢失一个 UDP datagram。

### 2.5 NAT、反向连接、multiplexing 和连接池

- NAT/反向连接：[Confirmed] node 主动向公网 gate 建立持久 TCP/TLS 连接，因此只需要内网出站连通。
- NAT hole punching：[Confirmed] 没有 STUN、ICE、UDP 打洞或直连协商。SPA 只是 gate 侧隐藏端口，不是 NAT 穿透。
- Multiplexing：[Confirmed] 强制使用 yamux；每个 node 只有一个物理 TCP/TLS session，control 和全部 TCP/UDP data stream 共享它。
- 连接池：[Confirmed] 没有多条 tunnel pool、预热 work connection、备用 session 或基于 CPU/带宽的 session sharding。
- visitor：[Confirmed] visitor 同样只建立一个 yamux session；流量始终经 gate relay。

### 2.6 身份认证、加密与 TLS

- Node：长期 bearer bootstrap token；gate.tok 直接以 token 为 key。无过期、nonce、challenge、session token、rotation 或 mTLS。
- Visitor：24 小时 ticket；gate 仅保存 SHA-256 hash，这是正确的 at-rest 处理，但 ticket 本身只有 48 bit 随机熵。
- Owner：scrypt(N=16384,r=8,p=1)+16-byte salt；登录成功签发 HMAC cookie，有效期 7 天。
- Tunnel TLS：internal/tlscfg/tlscfg.go:107-133 强制 TLS 1.3；node/visitor 使用私有 CA 和固定 ServerName=umbrad 验证 server。
- mTLS：[Confirmed] server tls.Config 设置了 ClientCAs，但没有设置 ClientAuth，因此不请求或验证客户端证书。
- 明文模式：命令行 --plain 显式关闭 tunnel TLS。没有网络协商式 downgrade，但存在部署误配置风险。
- 覆盖面：启用 TLS 时，control 与 data 都在同一个 TLS 连接内，均被加密。
- 证书生命周期：自动生成的 CA/server cert 有效期 10 年；CA 私钥生成后不保存，无法原地签发 client cert 或平滑轮换。

### 2.7 心跳、断线、重连和 session 生命周期

- 应用 Heartbeat：[Confirmed] gate 能接收 Heartbeat，但 node 从不发送。
- 实际 liveness：依赖 yamux 30 秒 keepalive 和 10 秒 write/ping timeout，通常约 40 秒发现死连接。
- Node reconnect：cmd/umbra-node/main.go:34-38 固定每 2 秒重试，无指数退避和 jitter。
- Visitor reconnect：[Confirmed] 没有外层重连循环；tunnel 断开后本地 listener 消失。
- TCP session：accept → open yamux stream → node dial local → 双向 copy → 两方向都结束后关闭。当前“都结束才关闭”的实现是泄漏根因。
- UDP session：以 source IP:port 为 key，定时器到期后关闭 stream。
- Hot upgrade：新旧进程依赖 SO_REUSEPORT 同时绑定；状态通过 state.json 快照恢复，但已建立 node session 无法迁移。

### 2.8 ACL、配置、日志和审计

- ACL：每 mapping 一个 AllowCidrs 字符串；空值允许全部。policy.CidrAllowed 逐项 ParseCIDR。
- IPv6 bug：无斜杠地址统一补 /32，IPv6 精确地址应为 /128，因而会错误拒绝。
- Agent egress：没有 agent/node 侧允许目标网段、拒绝 loopback/link-local/metadata 或 DNS 解析固定策略。
- 配置：CLI flags + 环境变量 + control.json；mapping 通过 UI/API 写内存并推送。没有 SIGHUP、事务、schema version 或严格启动校验。
- 日志：标准 log.Printf，缺少结构化字段、连接 ID、拒绝原因计数和远端身份。
- Audit：只保留最多 200 条 owner 操作，Actor 固定为 owner；不记录登录失败、token 认证、ACL 拒绝、数据连接建立/结束。
- Frames：internal/control/http.go:333-334 的 frame 日志由 HTTP postHello 模拟写入，不是 gate 实际收发 wire frame。
- Observability：无 Prometheus、OpenTelemetry、pprof 管理入口、健康状态细分、FD/goroutine/queue/window/丢包指标。

### 2.9 并发、socket I/O、buffer 与 backpressure

- 并发模型：goroutine-per-accepted-connection；每个端到端 TCP 连接约 6 个连接专属 goroutine，另有 node session 的 yamux goroutine。
- socket I/O：阻塞式 net.Conn/net.PacketConn；Go runtime netpoll 驱动，不是用户态 event loop。
- TCP copy：io.Copy，但包装器隐藏了 TCPConn 的优化接口，通常为每个方向分配一个 32 KiB copy buffer。
- UDP buffer：public/node 各有 64 KiB buffer；ReadDatagram 每包 make 新 slice。
- yamux：每 session 一个 sendCh(64)，单 send goroutine；每 stream 最大 256 KiB receive window。
- Backpressure：yamux per-stream window 能限制单 stream 未消费数据；底层仍共享单 TCP 队列。应用 rate limit 是“一秒窗口超限即报错/丢包”，不是等待式整形。

## 3. 安全审计发现

### SEC-01 — 预认证 yamux 内存/FD/goroutine 放大

Severity: Critical  
状态：[Confirmed]

- 问题描述：gate 在认证前为每个 TCP 连接创建完整 yamux session，并且接受首 stream、读取首 frame 时没有 deadline 或总握手预算。
- 攻击前提：攻击者能访问公开 :4400；TLS 不要求 client cert，攻击者可忽略 server 证书验证并完成 TLS。
- 攻击路径：
  1. 建立 TLS + yamux。
  2. 打开第一个 stream，但不完成 4-byte JSON 长度或 body，令 handleConn 阻塞在 wc.Read。
  3. 再打开 256 个 stream 并向每个发送最多 256 KiB；业务层不会 Accept 这些 stream。
  4. yamux incomingStream 将它们放进 acceptCh，readData 为每个 stream 分配 recvBuf。
- 影响：单连接理论预认证缓冲约 256 × 256 KiB = 64 MiB，外加 1 FD、至少 4 个 goroutine、stream/channel/map 元数据；少量连接即可 OOM。只建立慢连接也可消耗 FD/goroutine。
- 源码证据：
  - internal/gate/gate.go:111-145：无连接上限、无首包 deadline，认证发生在 yamux 之后。
  - internal/muxcfg/muxcfg.go:10-18：未覆盖 AcceptBacklog，继承 256；window 为 256 KiB。
  - yamux v0.1.2 mux.go:61-72、session.go:92-124、677-715、stream.go:477-519：backlog、3 个 session goroutine、未消费 stream 注册与按 frame 分配。
- 为什么存在：昂贵协议状态先于身份和 admission 创建；协议还允许对端双向开 stream。
- 修复方案：
  1. 最优：在创建 yamux 前增加固定长度、严格限时、无大分配的认证 preface，或用 mTLS 在 TLS 层拒绝未知 client。
  2. 设置 TLS handshake、首 stream、首 frame 的总 deadline（例如 5-10 秒）。
  3. 将预认证 AcceptBacklog 降到 1；认证完成前禁止额外 stream。
  4. 增加全局/每 IP handshake semaphore、连接速率限制和硬内存预算。
  5. 认证后持续 drain/reject node 发起的意外 stream，或采用方向明确的 mux。

### SEC-02 — node 撤销失效，旧 token 可重放

Severity: High  
状态：[Confirmed]

- 问题描述：Revoke 没有从 gate.tok 删除指向 nodeID 的 token。
- 攻击前提：攻击者曾获得 bootstrap token；token 可能来自 control.json、HTTP 抓包、部署参数、日志/命令历史或 node 主机。
- 攻击路径：owner 点击 revoke → 当前 session 被关闭 → 攻击者使用旧 token 重新 Enroll → gate.tok 仍命中 → 新 session 替换 node。
- 影响：身份撤销不成立；攻击者可持续 impersonate、踢掉合法 node、制造预认证/认证后资源攻击。热升级 Snapshot 会把残留 token 带到新进程。
- 源码证据：
  - internal/gate/gate.go:255-258 SetToken。
  - internal/gate/gate.go:314-336 Revoke 仅删除 nodes/entries，不遍历删除 tok。
  - internal/gate/gate.go:848-875 Snapshot 复制全部 token。
  - internal/control/http.go:351-363 只清空 control nodeRec.Token。
  - internal/node/node.go:201-203 使用 log.Fatal；supervisor 重启后仍会带旧 token 再连。
- 为什么存在：控制面记录和 gate 认证索引是两份状态，没有原子 credential lifecycle。
- 修复方案：credential 使用唯一 ID 和 hash；Revoke 在同一事务中标记 disabled、删除/拉黑 token、关闭所有关联 session；认证每次查询 authoritative credential state；增加 rotation、not-before/not-after、session epoch，测试冷重启与热升级。

### SEC-03 — TCP idle timeout、EOF 和 half-close 无法回收连接

Severity: High  
状态：[Confirmed]

- 问题描述：CopyBidirectional 等待两个 io.Copy 都返回后才 Close。一个方向超时/EOF 时，另一个方向可能永久阻塞。
- 攻击前提：公开 mapping 指向保持连接开放且不主动发数据的服务，例如 SSH、数据库或自定义 daemon。
- 攻击路径：攻击者连接公开端口后保持安静，或直接发送 FIN；public→tunnel copy 在 60 秒后超时/EOF，tunnel→public copy 仍阻塞于 yamux，WaitGroup 永不结束。
- 影响：e.active 不递减，stream、gate FD、node backend FD 和约 6 个 goroutine不释放。默认 64 条即可永久占满 mapping，形成低成本 DoS；正常半关闭协议也可能挂死。
- 源码证据：
  - internal/xfer/xfer.go:23-38。
  - internal/gate/gate.go:556-561、570-579：idle deadline 只在 public Read 前刷新。
  - internal/node/node.go:109-113：node 侧使用同一复制函数。
- 为什么存在：把“双向复制结束”误当作“任一方向结束后连接会自然结束”，没有 half-close 传播或 first-error cancellation。
- 修复方案：为 TCPConn 实现 CloseWrite/CloseRead 传播；任一硬错误立即取消另一方向；建立覆盖整个 connection 的 idle watchdog；确保 defer 先占用/释放 admission token；增加 FIN、RST、单向沉默和 backend 永不关闭测试。

### SEC-04 — 管理控制面默认裸 HTTP

Severity: High  
状态：[Confirmed]

- 问题描述：默认 :8080 同时承载 setup/login、owner cookie、node token、visitor ticket 和所有管理操作，但没有 TLS。
- 攻击前提：攻击者与管理员共享网络路径、反向代理配置错误，或 :8080 被公网/局域网直接访问。
- 攻击路径：嗅探/篡改 POST /v1/login、响应 cookie、GET bootstrap、visitor ticket，随后接管控制台或 node。
- 影响：完整控制面接管、内网 mapping 修改、agent 身份窃取、内部服务暴露。
- 源码证据：
  - cmd/umbrad/main.go:27、73、105-108 使用 net.Listener + http.Serve。
  - deploy/compose.gate.yml:14、21-24 使用 host network、:8080 和 0.0.0.0 entry bind。
  - internal/control/http.go:188-193 只有请求已经是 TLS 或 X-Forwarded-Proto=https 时才置 Secure。
- 防御现状：README 明确警告不要把 8080 暴露公网；这是运维建议，不是安全强制。
- 修复方案：默认绑定 Unix socket 或 127.0.0.1；公网模式必须配置 TLS/受信反代；可信代理列表后才能信任 forwarded headers；启动时拒绝“非 loopback + HTTP”；cookie 强制 Secure，并支持短会话和服务端撤销。

### SEC-05 — HTTP 慢连接、超大 body 和认证 CPU/锁 DoS

Severity: High  
状态：[Confirmed]

- 问题描述：HTTP server 没有任何超时与 body/header 限制；readJSON 直接 Decode；login 在 Console 全局 mutex 内执行 scrypt。
- 攻击前提：攻击者能访问管理 HTTP 端口；login/setup 无需 cookie。
- 攻击路径：Slowloris header/body、无限 JSON body、并发 login、用大量伪造源 IP 使 hits map 增长。
- 影响：FD/goroutine 耗尽；全局控制锁长时间被 scrypt 占用，阻塞管理、采样和状态读取；内存增长。
- 源码证据：
  - cmd/umbrad/main.go:105-108 直接 http.Serve。
  - internal/control/http.go:142-145 无 MaxBytesReader。
  - internal/control/control.go:333-353 在 c.mu 内 checkPassword/scrypt。
  - internal/control/control.go:102-105、339-347 hits 无全局清理。
- 修复方案：显式 http.Server，设置全部 timeout、MaxHeaderBytes 和 ConnState 限额；每路由 MaxBytesReader；认证 worker semaphore；在锁外计算 KDF，仅在锁内取 hash/更新计数；全局+每 IP rate limit、LRU/TTL hits；反向代理/WAF 层再限速。

### SEC-06 — MaxConns 可被并发越过，缺少全局 admission

Severity: High  
状态：[Confirmed]

- 问题描述：TCP/visitor 路径先 Load active，再开 stream，最后 Add(1)，不是原子占位。
- 攻击前提：任意公网用户可并发连接公开 mapping；visitor 攻击者需 ticket。
- 攻击路径：大量连接同时看到 active < MaxConns，全部通过检查并 OpenStream，然后再递增。
- 影响：配置的 64 并非硬上限；可瞬间创建大量 node backend 连接、stream、FD 和 goroutine。
- 源码证据：
  - internal/gate/gate.go:529、544-557。
  - internal/gate/gate.go:677-700、703-715。
- 修复方案：在开 stream 前用 channel semaphore 或 CAS 原子 reserve；失败路径统一 release；再加 gate 全局、node、mapping、source-IP、visitor-session 多层限额和 accept rate。

### SEC-07 — 非原子状态写入可导致 owner setup 重新开放

Severity: High  
状态：[Confirmed]

- 问题描述：control.json 直接覆盖写、忽略错误；读取/JSON 解析失败静默返回，ownerHash 保持空。
- 攻击前提：磁盘满、进程崩溃、容器/宿主异常重启、文件部分写入或人为损坏；攻击者随后能访问控制台。
- 攻击路径：状态文件截断 → 重启 → load 静默失败 → /v1/auth 显示未配置 → 攻击者率先 POST /v1/setup。
- 影响：控制面被重新认领，同时 mappings、tickets、audit 丢失。
- 源码证据：internal/control/control.go:157-165、203-226。
- 修复方案：临时文件写入、fsync、rename、目录 fsync；版本化 schema 和校验和；损坏时 fail closed 并要求离线恢复，绝不能回到 setup；保留上一版本和备份；持久层错误必须返回到 API/健康检查。

### SEC-08 — 长期 token/session 设计不满足现代身份生命周期

Severity: High  
状态：[Confirmed]

- 问题描述：node token 只有 48 bit CSPRNG 熵且长期复用；没有 expiry、nonce、challenge、session binding、rotation 或 key ID。owner cookie 7 天、完全无服务端 session，logout 不能撤销已复制 cookie。
- 攻击前提：凭证泄漏，或攻击者可长期在线猜测。
- 攻击路径：重放 token 即可建立新 node session并踢掉旧 session；复制 cookie 在 7 天内一直有效；ticket 建立后不再检查 expiry。
- 影响：泄漏窗口大、撤销困难、无法区分设备/会话、无法审计 credential 使用。
- 源码证据：
  - internal/control/control.go:228-232 仅 6 随机字节。
  - internal/control/http.go:271-283、608-634。
  - internal/control/control.go:356-391 cookie。
  - internal/gate/gate.go:182-203 last connection wins。
- 修复方案：至少 128/192 bit 随机 credential；bootstrap 一次性兑换短期 session credential 或 client cert；token hash 存储；challenge/nonce 或 TLS exporter channel binding；rotation/epoch/revoke；owner 服务端 session store、短 TTL、refresh、logout/revoke-all。

### SEC-09 — node 是无本地策略的内网任意 TCP/UDP egress 点

Severity: High（多租户/不完全可信控制面）；Medium（单 owner 强信任模型）  
状态：[Confirmed]

- 问题描述：node 无条件连接 gate 下发 mapping 的 LocalHost:LocalPort；支持 DNS 名称且每次连接重新解析，没有本地 allowlist/denylist。
- 攻击前提：gate、owner session 或配置供应链被攻破，或未来开放多用户但权限模型未改变。
- 攻击路径：创建 mapping 指向 127.0.0.1、RFC1918、link-local、云 metadata、Kubernetes API 或内部 DNS 名；利用 DNS 变更把同一名字解析到敏感地址。
- 影响：横向移动、SSRF 类访问、绕过内网边界；node 变成攻击者的内网代理。
- 源码证据：internal/node/node.go:94-113、116-125。
- 为什么存在：权限只在 gate 侧，node 不对“可访问目标”建立独立信任边界。
- 修复方案：node 本地 immutable allowlist；默认拒绝 loopback、link-local、metadata 和保留地址，按需显式开放；解析后校验全部 A/AAAA，连接前再次校验；可选固定 IP/Unix socket；mapping 签名并绑定 node、proto、target、expiry、config version。

### SEC-10 — visitor ticket 未严格绑定协议

Severity: Medium  
状态：[Confirmed]

- 问题描述：TCP mapping 的 visitor stream 可以声明 Proto=udp；gate 只校验 MappingID，随后按客户端 proto 选择 bridgeUDP，node 也优先使用 StreamOpen.Proto。
- 攻击前提：攻击者持有某 visitor mapping 的有效 ticket，并自行实现/修改 visitor client。
- 攻击路径：对 TCP mapping 发送 StreamOpen{Proto:"udp"}；访问同一 host:port 上可能完全不同的 UDP 服务。
- 影响：越过 ticket 预期协议边界，访问未授权的 UDP 服务；反向情况也存在语义混乱。
- 源码证据：
  - internal/gate/gate_visit.go:68-94。
  - internal/node/node.go:100-107。
- 修复方案：server 完全忽略客户端 MappingID/Proto/Via，全部从已认证 ticket/mapping 重建；要求 o.Proto 为空或严格等于 m.Proto；加入负面测试。

### SEC-11 — SPA grant 是 mapping 全局开门，不绑定请求源

Severity: Medium  
状态：[Confirmed]

- 问题描述：Knock 只记录 mappingID→until；在 60 秒窗口内所有来源都通过 SPA 检查。nftables 规则也是整个端口开放/关闭。
- 攻击前提：合法 owner 触发 knock；攻击者同时扫描或已知端口。
- 攻击路径：在 grant 窗口连接同一端口，再由 AllowCidrs 决定是否通过。
- 影响：SPA 不能证明连接者就是 knock 发起者；空 CIDR 时等同向全网开门 60 秒。
- 源码证据：internal/gate/gate.go:351-371、519-527；internal/stealth/stealth.go:89-105。
- 其他缺陷：stealth table 仅 IPv4；nft 失败会退化为 userspace accept+close，仍可被 SYN/端口扫描观察。
- 修复方案：grant 绑定 source IP/身份/单次 nonce，优先采用认证 visitor 或真正单包授权；IPv4/IPv6 一致；失败模式在 UI/health 中显式暴露。

### SEC-12 — SO_REUSEPORT 导致 mapping 冲突和热升级交叉路由

Severity: Medium；生产流量完整性场景可视为 High  
状态：[Confirmed]

- 问题描述：所有 Unix TCP/UDP listener 无条件启用 SO_REUSEPORT，API 又不拒绝重复 proto/entryPort。
- 攻击前提：owner 误配、状态恢复重复，或控制面被入侵。
- 攻击路径：两个 mapping 绑定相同端口；内核把新连接/datagram 分散到两个 entry。
- 影响：跨 node/target 错误路由、数据泄露、不可预测故障；热升级期间新旧进程也会随机分流。
- 源码证据：
  - internal/netutil/listen_unix.go:13-37。
  - internal/control/http.go:425-469 只检查非 visitor 有端口，不检查范围、协议、模式、冲突。
- 修复方案：控制面建立唯一端口 registry 和严格 schema；普通 listener 不启用 REUSEPORT；热升级使用 FD passing/socket activation，或带 generation 的受控 reuseport/eBPF steering。

### SEC-13 — CSRF、cookie 撤销和代理信任边界不足

Severity: Medium  
状态：[Confirmed]

- 问题描述：状态变更 API 没有 CSRF token/Origin 校验；SameSite=Lax 可缓解典型跨站 POST，但不能防同站 sibling origin。cookie 无服务端状态，logout 仅让浏览器删除当前副本。
- 攻击前提：同一 registrable domain 的子域被攻破、浏览器被诱导访问同站内容，或 cookie 被复制。
- 攻击路径：提交无需 body 的 revoke/delete/knock POST；或持续使用被复制的 7 天 cookie。
- 影响：mapping 改动、断开/撤销 node、签发 ticket。
- 源码证据：internal/control/http.go:25-60、112-129、183-193；internal/control/control.go:356-391。
- 修复方案：Origin/Referer allowlist + CSRF token；服务端 session ID 和 revoke；缩短 TTL；可信反代 CIDR 后才读取 X-Forwarded-*；为高风险操作增加 re-auth。

### SEC-14 — 协议解析的已有防御与剩余滥用面

Severity: Medium（滥用）；Low（长度溢出本身）  
状态：[Confirmed]

- 已有防御：
  - internal/wire/wire.go:124-137 在 make 前检查 max。
  - JSON 最大 1 MiB，datagram 最大 64 KiB。
  - uint32 转 int 后与很小的 max 比较，在当前 32/64 位目标上不会导致超大分配。
  - yamux 校验版本、消息类型和 stream receive window。
- 剩余问题：
  - 未认证连接仍可反复发送合法 1 MiB JSON 首帧，造成 allocation/JSON CPU amplification。
  - 认证 node 可持续发送 1 MiB Envelope/Heartbeat，没有消息速率或 control queue 配额。
  - 无协议版本和消息状态机，unknown 类型被静默忽略。
- 修复方案：首包上限应远小于运行期配置消息；流式/严格 JSON decoder、DisallowUnknownFields；每 session 消息速率和累计 bytes budget；显式状态机和版本/capability negotiation；go fuzz 覆盖 wire+yamux 边界。

### SEC-15 — 已知可达依赖/工具链漏洞与供应链门禁缺失

Severity: Medium；具体生产镜像需验证  
状态：[Confirmed] 本机；[Needs Verification] 已发布镜像

- govulncheck 在 go1.25.11 找到 5 个符号级可达标准库漏洞，修复线为 1.25.13。
- Dockerfile 使用浮动 golang:1.24-bookworm 和 node:22-bookworm；构建不可复现。
- 发布 workflow 只 build/push，不执行 go test -race、前端 test/typecheck、govulncheck、镜像扫描、SBOM 或签名；provenance 被显式关闭。
- 修复方案：固定已修补 patch+digest；CI 加测试、race、vet、fuzz smoke、govulncheck、npm audit/OSV、Trivy/Grype、SBOM 和 Cosign；失败阻止发布。

### SEC-16 — 高权限部署扩大任何漏洞的后果

Severity: Medium  
状态：[Confirmed]

- compose 使用 host network、NET_ADMIN、NET_BIND_SERVICE；镜像没有 USER，默认 root。
- 这是动态端口+nftables 的工程选择，但一旦 umbrad 出现 RCE，攻击者获得极大的宿主网络和防火墙控制面。
- 修复方案：拆分最小权限端口/防火墙 helper；主进程 rootless；仅 helper 持有必要 capability；只读 rootfs、no-new-privileges、seccomp/AppArmor、资源限制、独立 network namespace；优先外部 nft controller。

## 4. 稳定性与可靠性发现

### REL-01 — listener 失败后状态被伪装为成功，且不自动重试

[Confirmed] ensureEntry 在 listen 失败时仍把没有 ln/pc 的 entry 放进 s.ent。之后同配置 sameListen 返回 true，不再重试。getMappings 只要 node online+mapping enabled 就把 listenState 写成 listening、pushState 写成 acked；真实 MappingAck 又被 gate 忽略。

影响：控制台显示“已监听/已确认”，实际端口不存在；瞬时 EMFILE/EADDRINUSE 可变成持久故障。

证据：internal/gate/gate.go:412-477；internal/control/http.go:389-397；internal/gate/gate.go:230。

### REL-02 — accept loop 遇到任意错误永久退出

[Confirmed] control、mapping TCP、visitor local TCP 的 Accept 出错后直接 return。临时资源压力恢复后也不会继续服务。

证据：internal/gate/gate.go:111-118、509-516；internal/visit/visit.go:96-103。  
修复：识别 intentional close；其他错误指数退避重试并打指标，EMFILE 采用 reserve FD 技术。

### REL-03 — 在线状态可能永久陈旧，且存在数据竞争

[Confirmed] runNode 只有 wc.Read 错误路径调用 offline；onJSON 在后续消息返回错误时直接退出，不 offline。Hello 对 nodeConn 字段的写入未持有 s.mu，而 Status 在锁内读取；mapping 的 cur.spec 在 s.mu 内替换，数据路径无锁读取。

证据：internal/gate/gate.go:154-166、204-229、247-253、412-420、519-568、805-816。

影响：UI 长期显示 online，OpenStream 持续失败；race detector 在现有 happy-path 没覆盖这些并发更新。

### REL-04 — UDP idle timer refresh 有竞态，可关闭仍活跃 session

[Confirmed] 每个包 Stop 旧 timer 并创建 time.AfterFunc。若旧 timer 已开始等待 e.mu，Stop 返回 false；新包释放锁后，旧 callback 仍会看到同一个 sess 并删除/关闭它。

证据：internal/gate/gate.go:635-647；internal/visit/visit.go:190-201。

修复：单 timer.Reset 配合 generation/deadline 检查；或集中 timing wheel；读写活动都刷新 idle。

### REL-05 — reconnect 与 failure recovery 不成熟

- [Confirmed] node 固定 2 秒，无 jitter/backoff；大量 node 会同步重连。
- [Confirmed] node/visitor 在 TCP Dial 后执行 tls.Handshake，但不设置 handshake deadline。
- [Confirmed] visitor 无重连。
- [Confirmed] 只有 yamux keepalive，无应用 heartbeat、mapping/config version、resume 或快速故障转移。

### REL-06 — 热升级不是零中断

[Confirmed] 新进程先绑定 SO_REUSEPORT listener、加载 mapping，再等待 takeover；旧 agent session 不能传给新进程。重叠期间流量可能被内核送到没有在线 node 的新 entry；旧进程退出后所有旧 session 被杀，必须等 node 重连。

证据：cmd/umbrad/main.go:48-60、62-77、100-157；internal/gate/gate.go:906-938。

### REL-07 — 没有 HA、共享状态和水平扩展协议

[Confirmed] owner、nodes、mappings、tickets、audit 和 traffic sample 都是单进程内存/单 JSON 文件；agent session 只存在本机；mapping listener 也在本机。

这意味着：

- gate 是控制面与数据面的共同单点。
- 外部 L4 LB 不能无状态地分配 tunnel/data connection。
- 同一 node 不能同时连多个 gate，也没有 leader/lease/session ownership。
- 热备机无法接管既有 listener/session。

## 5. 性能审计

### 5.1 单向 TCP 数据路径

以 User → Internal Service 为例：

~~~text
public TCP socket
  │ Read into gate io.Copy 32 KiB buffer
  ▼
idleConn → countWriter → rwLimit
  │ mapping mutex + one-second Window
  ▼
yamux Stream.Write
  │ copy payload into session body buffer
  │ shared sendCh(64) / single send goroutine
  ▼
TLS.Conn.Write(header) + TLS.Conn.Write(body)
  │ encryption over one TCP connection
  ▼
node TLS/yamux recv
  │ copy into per-stream recvBuf
  ▼
yamux Stream.Read
  │ copy into node io.Copy 32 KiB buffer
  ▼
internal TCP socket Write
~~~

反向路径结构相同，但当前 rate limiter 只在 public→node 方向。

### 5.2 read、write、copy、allocation、serialization

对每个方向、每个 io.Copy chunk：

- 业务转发层逻辑 Read：2 次  
  gate 从 public socket 读；node 从 yamux stream 读。
- 业务转发层逻辑 Write：2 次  
  gate 写 yamux stream；node 写 internal socket。
- yamux 内部：[Confirmed] 一个 Stream.Write 由 session send goroutine分别向底层连接写 12-byte header 和 body。
- 底层系统调用次数：[Needs Verification] TLS record、TCP buffering、GSO/TSO 和 runtime poller 会影响实际 read/write syscall 数，必须用 strace/perf 抓取，不能从 Go 调用数直接等同。
- 确定的 Go 用户态 payload copy 至少 3 次：
  1. gate io.Copy buffer → yamux send body buffer；
  2. node TLS/yamux reader → yamux recvBuf；
  3. yamux recvBuf → node io.Copy buffer。
- 另有 public socket kernel→user、internal socket user→kernel两次边界复制；TLS 加解密还会使用实现相关 record buffer。
- 数据 serialization：[Confirmed] TCP payload 不做 JSON；每条 stream 只有一次 StreamOpen JSON+4-byte frame。
- Encryption：[Confirmed] TLS 开启时每个 data chunk 加密/解密一次。
- Multiplexing：[Confirmed] 经过 yamux。
- Queue/channel：[Confirmed] session sendCh 容量 64、acceptCh 256、per-stream recvBuf/window。
- 锁：
  - [Confirmed] 每个 public→node write 都调用 e.take，即使 RateKbps=0，也获取 mapping 级 e.mu。
  - yamux 有 session stream map lock、send channel、per-stream recv/send lock。
  - 每个 chunk 更新共享 mapping atomic counter。

### 5.3 allocation 与 GC 压力

- [Confirmed] io.Copy 优化路径被 idleConn、countWriter、rwLimit 等 wrapper 隐藏，四个 copy goroutine通常各自分配 32 KiB buffer，即每端到端 TCP 连接至少约 128 KiB copy buffer。
- [Confirmed] yamux 每端每 stream receive window 最大 256 KiB；满双向压力下，两端合计可达约 512 KiB。
- [Confirmed] wire.ReadDatagram 每包 make 精确长度 slice；visitor↔gate↔node 路径会在多个 hop 重复分配。
- [Confirmed] gate/visitor 为每个 UDP source 创建/销毁 timer；高 PPS 会压 timer heap 和 GC。
- [Confirmed] 没有 sync.Pool 或显式 CopyBuffer。

### 5.4 并发与锁热点

- 每端到端 TCP 连接约 6 个专属 goroutine：
  - gate handleTCP 1 + copy 2；
  - node handleStream 1 + copy 2。
- 每连接 FD：
  - gate 1 个 public socket；
  - node 1 个 backend socket；
  - node session 的 1 个物理 tunnel FD 是共享的。
- [Confirmed] e.mu 是同 mapping 全部入站流量的热点锁；即便无限速也串行进入。
- [Confirmed] UDP 每 datagram 还获取 gate 全局 s.mu 查 node，再获取 e.mu。
- [Hypothesis] 单 mapping 高吞吐首先受 e.mu、yamux 单 send goroutine、TLS 单连接和共享 TCP congestion window 限制。
- Accept 本身通常不是首瓶颈；无 admission 的 goroutine/FD/memory 增长更早成为问题。

### 5.5 Multiplexing、HOL、公平性和 backpressure

- Per-stream 256 KiB window 可防一个消费者无限吃掉接收内存。
- 但所有 stream 共用一条 TCP/TLS connection和一个 FIFO send goroutine。
- [Confirmed] 底层 TCP 丢包导致所有 stream HOL；UDP 也被迫等待重传。
- [Hypothesis] 大流持续提交 32 KiB frame 时会占据 sendCh 和单 send loop，小流/control heartbeat/mapping sync 的 tail latency 上升。
- 没有 stream priority、weighted fair queue、per-stream bandwidth scheduler 或 control/data 独立 transport。
- 没有多连接 striping；单 node 的总带宽受单 TCP congestion window、单核 TLS/yamux path 和一个 session send loop 约束。

### 5.6 rate limiter 实际语义

[Confirmed] policy.Window 是 mapping 级固定一秒窗口。超限时：

- TCP rwLimit.Write 返回 error，io.Copy 退出；受 SEC-03 影响，连接还可能不被完整关闭。
- UDP 直接丢 datagram。
- 只限制 public/visitor→node 方向，反向不限。
- 小于一个 io.Copy chunk 的低速率配置可能让单次 32 KiB write 直接失败。

它不是平滑 token bucket，不提供等待、burst、双向、公平或 per-connection backpressure。

### 5.7 延迟来源

已建立 node session 后，新 public TCP 连接：

1. gate accept、策略检查。
2. gate→node yamux SYN + StreamOpen，一个 tunnel 单向传播。
3. node→internal TCP handshake，一个内网 RTT。
4. 首字节经 node→gate 返回。

不需要重新建立 tunnel TCP/TLS，这是 multiplexing 的延迟优势。

Node 冷连接大致需要：

- outer TCP handshake：1 RTT；
- TLS 1.3 full handshake：1 RTT；
- Enroll/EnrollOk：约 1 RTT；
- Hello/HelloOk：约 1 RTT。

因此在无丢包时约 4 个 gate RTT 才完成完整 online/config 同步；固定 2 秒 reconnect sleep 额外增加 0-2 秒等待。以上为协议推导，[Needs Verification] 需要抓包测量。

### 5.8 内存规模估算

假设连接活跃、TLS 开启、不计 UI/control map，不计 Linux socket memory，且已把 MaxConns 和 ulimit 调高：

| 并发 TCP | io.Copy buffer 下限 | 连接专属 goroutine | yamux 双端最大 recv backlog | 粗略用户态压力 |
|---:|---:|---:|---:|---:|
| 100 | 12.5 MiB | 约 600 | 最多 50 MiB | 约 65 MiB + metadata/TLS |
| 1,000 | 125 MiB | 约 6,000 | 最多 500 MiB | 约 0.65 GiB + metadata/TLS |
| 10,000 | 1.22 GiB | 约 60,000 | 最多 5 GiB | 约 6.5 GiB + metadata/TLS |
| 100,000 | 12.2 GiB | 约 600,000 | 最多 50 GiB | 约 64 GiB + metadata/TLS |

说明：

- goroutine 初始栈通常约 2 KiB，600k goroutine仅初始栈又约 1.1 GiB，且会增长。
- kernel socket buffer、sk_buff、TCP state、FD table 和 TLS buffer未计入。
- 正常稳态 recvBuf 不一定填满 256 KiB，因此“最大 backlog”不是常驻值；但慢消费者/突发流量会逼近。
- 实际最先撞到的资源通常依次是：默认 FD limit → MaxConns 逻辑/泄漏 → 内存/GC → 单 tunnel CPU/带宽 → 调度开销。

### 5.9 网络开销

- yamux 每 data frame 固定 12 byte header。
- TLS 1.3 record 通常还有 5-byte record header、1-byte inner content type 和 16-byte AEAD tag。
- 当前 yamux 对 header/body 分两次底层 Write；[Hypothesis] 若 Go TLS 分别产生 record，一个 TCP data chunk 的 tunnel 固定开销约为 12 + 2×22 = 56 bytes，未计 outer TCP/IP。
- UDP 的 4-byte length 和 payload又分别调用 Stream.Write；[Hypothesis] 可能产生两组 yamux header/body record，约 116 bytes 固定 tunnel 开销/包，64-byte payload 时尤其昂贵。
- TLS 是否合并 record、TCP 是否合并 segment 必须用 pcap 验证，不能把上面推导当成实测值。

## 6. 可执行 Benchmark 设计

### 6.1 公平拓扑

至少使用三台 Linux 主机或三个 network namespace：

~~~text
Load Generator G ── WAN-A ── Gate S ── WAN-B/LAN ── Agent A ── Echo Backend
~~~

Direct 基线必须保持相同总 RTT、MTU 和带宽。建议用 Linux tc netem 分别设置：

- clean LAN：0.2 ms、0% loss；
- typical WAN：20 ms + 20 ms、0.01% loss；
- lossy WAN：40 ms + 40 ms、0.5% loss、1% reorder；
- bandwidth：100 Mbps、1 Gbps、10 Gbps 三档；
- MTU：1500 和 1280。

不要把 Direct 放在同机 loopback、而 tunnel 跨 WAN；那只是在比较拓扑，不是在比较代理开销。

### 6.2 被测矩阵

每个项目记录精确版本和配置：

- Direct TCP。
- Umbra：TLS on；plain 仅作为诊断子项，不进入安全等价主排名。
- frp v0.71.0：TLS force；分别测 tcpMux=true/false，poolCount=0/适当预热。
- nps v0.26.10/master：明确记录 tcp/kcp、crypt/compress 配置；安全性不等价必须在结果标注。
- Pangolin/Newt/Gerbil：WireGuard 默认路径；raw TCP/UDP 需自建。

连接数：1、100、1k、10k。  
payload：64 B、1 KiB、16 KiB、连续 1 MiB block。  
每组：30 秒 warm-up，60 秒测量，至少 5 次，随机化执行顺序。

### 6.3 工具与命令

#### TCP throughput / large stream

~~~text
iperf3 -s -p TARGET_PORT
iperf3 -c TARGET_HOST -p TARGET_PORT -t 60 -O 10 -P 1  -J
iperf3 -c TARGET_HOST -p TARGET_PORT -t 60 -O 10 -P 100 -J
iperf3 -c TARGET_HOST -p TARGET_PORT -t 60 -O 10 -P 1000 -J
~~~

iperf3 不适合 10k 短连接；1k 以上需分多个 generator 进程/主机，避免 generator 自身成为瓶颈。

#### Request/response latency 和 small packet

Backend 使用 netserver：

~~~text
netserver -p TARGET_PORT
netperf -H TARGET_HOST -p TARGET_PORT -t TCP_RR -- -r 64,64
netperf -H TARGET_HOST -p TARGET_PORT -t TCP_RR -- -r 1024,1024
~~~

高并发使用 tcpkali：

~~~text
tcpkali -c 100   -T 60s -m MESSAGE TARGET_HOST:TARGET_PORT
tcpkali -c 1000  -T 60s -m MESSAGE TARGET_HOST:TARGET_PORT
tcpkali -c 10000 -T 60s -m MESSAGE TARGET_HOST:TARGET_PORT
~~~

若要可靠得到 p50/p95/p99，建议实现一个独立 Go tcpbench：

- rr 模式：固定长度 echo，记录 HDR histogram；
- stream 模式：每连接持续写/read；
- connect 模式：dial→可选 1-byte echo→close，记录 connects/sec 和失败类型；
- 使用每 worker 本地 histogram，结束后合并，避免中央 channel 干扰结果；
- 输出 JSON/CSV：project,version,scenario,connections,payload,throughput,p50,p95,p99,errors。

#### connections/sec

~~~text
tcpkali --connect-rate 1000 -c 1000 -T 60s TARGET_HOST:TARGET_PORT
~~~

逐步升到失败率 0.1%、1%、5%，找最大 sustainable connect rate，而不是只记录瞬时峰值。

#### CPU、内存、FD、goroutine

~~~text
pidstat -urd -p PID 1
perf stat -p PID -e cycles,instructions,cache-misses,context-switches,cpu-migrations,page-faults
watch -n1 'ls /proc/PID/fd | wc -l'
cat /proc/PID/status
cat /proc/net/sockstat
ss -s
~~~

Umbra 当前没有 pprof。第一阶段可用：

~~~text
perf record -F 99 -g -p PID -- sleep 60
perf report
~~~

后续加入只绑定 loopback/Unix socket、需鉴权的 pprof，再采：

~~~text
go tool pprof -http=:0 http://127.0.0.1:PPROF/debug/pprof/profile?seconds=60
go tool pprof -http=:0 http://127.0.0.1:PPROF/debug/pprof/heap
go tool trace trace.out
~~~

#### 网络开销

同时抓 public leg 和 tunnel leg：

~~~text
tcpdump -i IFACE -s 128 -w tunnel.pcap 'host GATE_OR_NODE'
capinfos tunnel.pcap
tshark -r tunnel.pcap -q -z io,stat,1
~~~

Bandwidth overhead = (tunnel leg bytes - application payload bytes) / application payload bytes。  
需分别报告 L4 bytes、IP bytes 和 Ethernet wire bytes。

#### reconnect/failure recovery

测量时间点：

1. t0：iptables/nft drop tunnel 或 kill -9 node。
2. 旧连接第一次失败。
3. gate 标记 offline。
4. node 开始重连。
5. control/config 恢复。
6. 第一条新 public connection 成功。

故障类型：

- 5 秒、30 秒、120 秒黑洞；
- RST；
- node kill/restart；
- gate kill/restart/热升级；
- 50%、1% packet loss；
- backend 停止/恢复。

输出 detect time、reconnect time、first-success time、existing connection survival、失败连接数、重连峰值 QPS。

### 6.4 必须防止 benchmark 自身失真

- CPU pinning：taskset；记录 governor/turbo。
- generator、gate、agent、backend 分核/分机。
- 提高并记录 ulimit -n、somaxconn、ip_local_port_range、nf_conntrack_max。
- 10k 连接避免客户端 ephemeral port 不足；使用多源 IP。
- 每轮清理 TIME_WAIT 或等待稳定，不使用危险 sysctl 掩盖真实行为。
- 所有项目使用等价加密/认证强度；不把 nps insecure TLS 或 Umbra plain 的数字与安全配置直接排名。
- 报告失败率和资源曲线，不能只报成功样本的 p99。

本阶段没有向仓库添加 benchmark 程序，因为当前工作树已经包含大量未完成改动，且应先修 P0 生命周期问题；否则 10k 测试主要测出已知泄漏和 admission 缺失，数据难以指导微优化。

## 7. 与 frp、nps、Pangolin 的差距

竞品基线：

- frp：官方 v0.71.0（2026-08-14）。
- nps：官方最新 release v0.26.10（2021-04-08），并核对官方 master；项目长期未发版。
- Pangolin：核对 2026-08-26 前后的 Pangolin/Newt/Gerbil main 与当前官方文档。

### 7.1 架构/能力对比

| 维度 | Umbra 当前 | frp 0.71 | nps 0.26.10/master | Pangolin 当前 |
|---|---|---|---|---|
| 架构 | 单 umbrad 合并控制、数据、UI、状态 | frps/frpc，proxy/visitor/work connection 分层 | nps/npc + web/bridge/mux | Pangolin 控制/身份，Gerbil WireGuard，Newt edge，router/Badger 分层 |
| Control plane | yamux 首 stream + JSON，无版本 | 版本化消息；v2 capability/AEAD；首消息 deadline | 自定义 bridge 信令 | HTTPS/temporary token + WebSocket control |
| Data plane | 单 TLS/TCP + yamux | TCP mux 可开关；独立 work conn/pool；KCP/QUIC/WS/WSS | 自定义 mux、TCP/KCP、P2P | WireGuard packet tunnel + TCP/UDP proxy |
| TCP | 有 | 有 | 有 | 有 |
| UDP | UDP-over-TCP stream | 原生 UDP proxy/QUIC/KCP，v2 binary UDP codec | 有 UDP/KCP | WireGuard/UDP packet path |
| Multiplexing | 强制、单 session | 默认 mux，可关闭；多 transport | 自定义 mux | 由 WireGuard 网络层承载，不是同类 stream mux |
| 连接池 | 无 | bounded poolCount/maxPoolCount | mux + goroutine/buffer pool | 持久 WireGuard；Gerbil 还有连接池组件 |
| NAT traversal | 仅反向 relay | STCP/SUDP/XTCP、NAT hole/P2P | P2P/UDP 打洞 | WireGuard hole punch + relay |
| TLS/加密 | TLS1.3，私有 CA server 验证；无 mTLS | TLS 默认开；force、server/client/bidirectional verify；v2 control AEAD | 可选 TLS 但 client InsecureSkipVerify；旧 AES-CBC 无认证 | HTTPS/WSS；可选 mTLS；data 为 WireGuard ephemeral keys |
| Agent auth | 长期 48-bit bearer | token 或 OIDC；tokenSource file/exec | MD5(vkey) 静态校验 | ID+secret 换 temporary session credential；可 rotation/disconnect（部分 EE） |
| ACL | mapping source CIDR | allowPorts、maxPorts/client、plugins、proxy auth | IP/port/user/web 多项控制 | org/RBAC/API scope/private resource policy；raw public L4 明确无身份策略 |
| Multi-user | 单 owner | user namespace/插件，非完整 RBAC 控制平台 | 有多用户 web | org、user、role、OIDC、scoped API key |
| Backpressure | yamux window；超限断流 | mux/window + work pool + token-bucket bandwidth limiter | mux、buffer/goroutine pool、rate/flow/max_conn | WireGuard/OS network stack；proxy timeout/pool；API rate limit |
| Resource limits | 每 mapping MaxConns，且可竞态越过 | allowPorts、maxPortsPerClient、maxPoolCount、userConnTimeout | max_conn、flow/rate，巨大固定 goroutine pool上限 | API/auth rate limit；Gerbil UDP connection cap；容器/集群能力 |
| QUIC/KCP | 无 | QUIC、KCP | KCP | WireGuard over UDP，不等同 QUIC |
| Health/recovery | yamux keepalive；fixed retry | heartbeat timeout、health check、load balancing、重连 | Android/SDK/客户端重连能力不一致 | WS ping/pong deadline、reconnect、health monitor |
| Observability | 内存计数、200 audit、无 metrics | dashboard、Prometheus、pprof、日志 | web stats、pprof | Prometheus/OTel、tunnel/session/handshake/proxy metrics |
| PROXY protocol | 无 | 支持 | 部分代理能力 | raw TCP 可启用 |
| HA | 无 | frps 本身仍是 tunnel session 单点；proxy group可做后端级 HA | 无成熟集群 | EE 支持 PostgreSQL+Valkey+多实例/多 Gerbil/负载均衡 |
| 水平扩展 | 无 | 需外部编排/粘性；无透明迁移既有 tunnel | 无 | 官方集群能力（EE） |
| Config reload | API push但无事务/version；状态不可靠 | verify、strict config、includes、admin/store runtime reload能力 | web/config 管理 | Web/API、config version、共享状态；raw端口配置仍可能需重启 |
| DoS 防护 | 预认证和 HTTP 基本无硬限额 | 首消息 timeout、池/端口限制；仍需外部防护 | 5s bridge deadline但旧安全栈风险大 | API/auth rate limits、分层服务；raw L4仍需防火墙/边缘防护 |
| 性能优化 | io.Copy 默认 buffer、无 pool、单 mux | 可选 mux/QUIC/KCP/pool/compression、带宽 limiter | 多 sync.Pool、copy buffer、ants pool | WireGuard；Newt UDP sync.Pool；Gerbil buffer pool/metrics |
| 部署复杂度 | 低，但需 host net+NET_ADMIN | 低到中 | 低到中但老旧 | 高；Pangolin+Gerbil+router+DB/Valkey，raw port还需 firewall/compose/router 配置 |

### 7.2 为什么 frp 的部分设计更成熟

1. 认证前资源控制  
   frp server 在读取首消息时设置约 10 秒 deadline；Umbra 在创建 yamux 后首帧无限等。成熟点不是“用了不同 mux”，而是昂贵状态前后有明确 timeout/admission 边界。

2. data connection lifecycle  
   frp 把 control connection 与 work connections/pool 作为显式对象管理；pool 有 server max。Umbra 只有一个不可替代的 session，所有 data stream依附其上。

3. transport 是可选择的  
   frp 可在 TCP、KCP、QUIC、WebSocket/WSS 间选择，tcpMux 也可关闭。这让高丢包、UDP、短连接和大带宽场景能采用不同机制；Umbra 强制所有流量进入单 TCP mux。

4. 配置与资源边界  
   frp 有 strict validation、allowPorts、maxPortsPerClient、maxPoolCount、userConnTimeout，并在 v0.71.0 修复 negative pool_count 远程 DoS。Umbra 对 proto/port/rate/limit/重复 listener 缺少统一 validation。

5. 身份和 TLS 选项更完整  
   frp 支持 token、OIDC、token source 和 mTLS。但需要客观看待：frp 默认 token 仍是共享秘密；若 client 不配置 trusted CA，其某些默认 TLS 模式不等同于 Umbra 私有 CA pinning。Umbra 在“默认 server 证书校验”这一点并不弱。

6. 可观测性和运维闭环  
   Prometheus、pprof、健康检查、负载均衡、真实 proxy 状态让故障可被检测和自动摘除；Umbra UI 当前会把失败 listener/未处理 Ack 展示为成功。

### 7.3 为什么不能把 nps 当成安全标杆

nps 的功能面和一些性能工程比 Umbra 丰富：

- TCP/UDP/SOCKS/HTTP/P2P/KCP；
- 多用户 web；
- sync.Pool copy/UDP buffers；
- ants goroutine pool；
- rate/flow/max_conn、pprof。

但官方代码也存在明显遗留安全设计：

- bridge 使用 MD5(vkey) 静态值；
- TLS client 设置 InsecureSkipVerify=true；
- AES-CBC 使用 key 前缀作为 IV 且无 MAC/AEAD；
- 示例 public_vkey/web password 很弱；
- 最新正式 release 停留在 2021。

因此 nps 的比较结论应是：“功能和资源复用更丰富，但当前官方安全基线与维护状态不适合作为 Umbra 的认证/加密模板。”

### 7.4 为什么 Pangolin 的架构更接近生产平台

1. 控制面与数据面分离  
   WebSocket 只承载 control，数据走 WireGuard。大量 data traffic 不会直接堵住登录/配置消息；UDP 也不承担 TCP-over-TCP 语义。

2. 凭证分阶段  
   site ID+secret 先换临时 session credential，随后用 ephemeral WireGuard keys 建 tunnel。Umbra 是同一个长期 bearer 同时承担 enrollment 和所有未来 reconnect。

3. 身份/租户模型独立  
   org、role、用户、OIDC、scoped API key、private resource policy 是控制面的基础数据结构，不是 mapping 上附加一个 CIDR 字符串。

4. HA 有共享状态模型  
   官方 EE 集群用 PostgreSQL 保存持久状态、Valkey 同步 session/tunnel 状态、LB 分配请求。Umbra 的 JSON 快照+SO_REUSEPORT 不具备一致性、租约和 session ownership。

5. 但 Pangolin 不是所有方面都更简单或更强  
   raw public TCP/UDP 官方明确是 unauthenticated pipe，身份策略适用于 private/HTTP 等资源；raw 端口部署还要改 firewall、Docker 和 Traefik 并重启。其 HA 和 credential rotation 的部分能力属于 Enterprise Edition。

## 8. P0-P3 整改表

| Priority | Category | Problem | Evidence | Impact | Competitor implementation | Recommended fix | Complexity |
|---|---|---|---|---|---|---|---|
| P0 | DoS | 认证前创建 yamux，首包无 deadline，约 64 MiB/连接放大 | gate.go:111-145；muxcfg.go；yamux backlog/window | 公网 OOM/FD/goroutine 耗尽 | frp 首消息 deadline；Pangolin HTTPS/WS 层限时与 rate limit | pre-auth preface/mTLS、deadline、backlog=1、全局/IP semaphore | L |
| P0 | Auth | Revoke 不删除 gate token | gate.go:314-336、848-875 | 旧 token 重放、身份撤销失效 | Pangolin regenerate+disconnect；frp credential/auth lifecycle | authoritative hashed credentials、epoch、原子 revoke/close | M |
| P0 | Lifecycle | 双向 copy 等两端结束，idle/EOF 泄漏 | xfer.go:23-38；gate.go:556-579 | 64 个廉价连接占满 mapping，FD/goroutine泄漏 | Newt 两方向任一结束会关闭对端；frp work conn有超时/回收 | half-close/cancel、connection watchdog、负面测试 | M |
| P0 | Management security | 默认 :8080 裸 HTTP | main.go:27、105；compose.gate.yml | 管理口令/cookie/token/ticket被窃取 | Pangolin HTTPS；frp dashboard可配置 TLS | 默认 loopback/unix；公网强制 TLS/受信反代 | S-M |
| P0 | HTTP DoS | 无 HTTP timeout/body/conn limit，scrypt持全局锁 | main.go:105；http.go:142；control.go:333 | 慢连接、CPU和控制锁 DoS | Pangolin global/auth rate limit；frp web server边界 | 显式 http.Server、MaxBytesReader、auth semaphore/rate limit | M |
| P0 | Admission | MaxConns TOCTOU；无全局/每IP/每node限额 | gate.go:529-557、677-715 | 突发越限、backend/FD风暴 | frp maxPool/maxPorts/user timeout；Gerbil connection cap | 原子 reserve + 多层 quota | M |
| P0 | Persistence | control.json 非原子且损坏后开放 setup | control.go:157-165、203-226 | 控制面被抢占、配置全丢 | Pangolin DB/transaction；frp config validation | atomic+fsync+backup+schema；损坏 fail closed | M |
| P0 | Routing integrity | 无 mapping validation + 全局 SO_REUSEPORT | http.go:425-469；listen_unix.go:13-37 | 跨 mapping 随机路由/泄露 | frp strict validation/allowPorts/duplicate checks | schema、唯一端口 registry、FD handoff替代通用 reuseport | M-L |
| P1 | Reliability | listener失败仍显示 listening/acked，且不重试 | gate.go:412-477；http.go:389-397 | 静默黑洞 | frp health/status；Pangolin health monitors | state machine+Ack correlation+retry/error surfaced | M |
| P1 | Race/state | nodeConn/mapping并发读写，错误路径不offline | gate.go:154-166、204-229、412-420 | stale online、数据竞争 | 竞品显式 control/session state machine | immutable snapshot/locks/atomic state，defer offline | M |
| P1 | UDP | UDP-over-TCP、timer race、per-packet allocation | gate.go:582-675；wire.go:107-137 | HOL、GC、活跃session误关 | frp QUIC/KCP/native UDP；Pangolin WireGuard | 独立 QUIC/UDP data plane；pool+deadline/timing wheel | L-XL |
| P1 | Rate limit | mapping全局 mutex；超限断流；单向 | gate.go:560-568；policy.go:51-70 | 吞吐热点、错误语义 | frp token-bucket client/server limiter | disabled fast path；x/time/rate等待式双向/分层限速 | M |
| P1 | Recovery | fixed 2s无jitter；visitor无重连；TLS handshake无deadline | node main:34-38；node.go:23-36；visit.go | 惊群、挂死、人工恢复 | frp heartbeat/reconnect；Newt pong deadline/reconnect | exponential backoff+jitter、handshake context、visitor resume | M |
| P1 | Upgrade/HA | SO_REUSEPORT热升级无session迁移；单机JSON | main.go:111-157；gate.go:906-938 | 升级中断、单点、不能横向扩展 | Pangolin EE DB+Valkey+LB；frp proxy group仅后端级HA | 先正确 drain/FD handoff；后续 shared state/session ownership | L-XL |
| P1 | Agent trust | 无 node 本地 target allowlist | node.go:94-125 | 控制面失陷后横向移动/metadata访问 | Pangolin org network isolation；frp plugin/policy扩展 | 本地 policy、解析后IP校验、signed mapping | M-L |
| P1 | Dependencies/CI | 可达 Go 漏洞；发布无安全门禁 | govulncheck；Docker/workflow | 已知漏洞进入镜像、不可复现 | frp活跃发布/兼容策略；Pangolin独立安全流程 | patched digest、tests/scans/SBOM/signing | S-M |
| P2 | Performance | 4×32 KiB copy buffer/连接，无 pool | xfer.go wrappers | 10k时仅copy buffer约1.22GiB | nps/Newt/Gerbil buffer pool；frp transport优化 | CopyBuffer+pool；减少wrapper层；批量计数 | M |
| P2 | Multiplexing | 单 session/send loop/cwnd；control/data共线 | node.go:39；muxcfg.go | HOL、单node带宽和tail latency上限 | frp mux可关+pool+QUIC；Pangolin control/data分离 | 多session pool、control独立、QUIC/packet path、fair queue | L-XL |
| P2 | Observability | 无 Prometheus/OTel/pprof；audit/frames不真实 | control.go/http.go | 无法容量规划和定位事故 | frp Prometheus/pprof；Pangolin OTel/Prometheus | structured logs、metrics、traces、真实audit | M |
| P2 | Protocol | 无版本/capability/config generation | wire.go；version仅展示 | 升级兼容与状态收敛不可控 | frp wire v2/compat policy；Newt configVersion | version handshake、feature bits、idempotent revision/Ack | M-L |
| P2 | Client IP | backend丢失源地址 | StreamOpen只存PeerIP | 审计/ACL/rate limit困难 | frp/Pangolin PROXY protocol | 可选 PROXY v1/v2，target显式信任 | M |
| P3 | Engineering | 前端 test/typecheck失败；双控制面遗留代码 | npm结果；actions.ts vs api.ts | CI噪声、维护误判 | 竞品统一配置/验证工具 | 删除或隔离dead path，修类型与测试fixture | M |
| P3 | Testing | 缺少 fuzz/chaos/scale/security regression | gate_test仅happy path | 修复易回归 | frp大量边界测试；Newt连接生命周期测试 | fuzz wire、断流、revoke、10k、race stress、chaos | M-L |

## 9. 最值得优先解决的 Top 10

1. 在 yamux 前完成低成本、限时认证；加全局/每 IP handshake admission。
2. 修复 Revoke：旧 credential 立即且永久失效，覆盖热升级/重启。
3. 重写 TCP splice 生命周期：half-close、first-error cancellation、idle watchdog、配额必释放。
4. 管理 API 默认只允许 loopback/Unix socket；公网必须 TLS；完善 cookie/session/CSRF。
5. 使用显式 http.Server timeout、body/header/connection limit，并把 scrypt 移出全局锁。
6. 把 MaxConns 改为原子 reservation，并建立 gate/node/mapping/source 多层资源限额。
7. 严格验证 mapping，禁止端口冲突，移除普通 listener 的 SO_REUSEPORT。
8. control state 原子持久化、fail-closed 恢复、schema/version/backup；修真实 listener/Ack 状态。
9. 拆开 UDP 与单 TCP mux：至少提供 QUIC/独立 UDP transport；同时修 timer race 和 per-packet allocation。
10. 建立发布门禁与可观测性：patched/pinned toolchain、race/fuzz/govuln/image scan、Prometheus/pprof/structured audit。

## 10. 推荐路线图

### Phase 1：安全底线

- SEC-01 预认证边界、deadline、admission。
- SEC-02/08 credential hash、128+ bit、一次性 bootstrap、session credential、revoke/rotation。
- SEC-04/05/13 管理面 TLS/loopback、HTTP hardening、CSRF、server-side session。
- SEC-06 原子配额和全局资源限制。
- SEC-07 状态 fail closed/atomic persistence。
- SEC-12 mapping schema、端口唯一性。
- 升级到已修补 Go，固定镜像 digest；rootless/最小 capability。

退出标准：公开端口可承受未认证 slowloris/stream flood；撤销可证明；管理凭证不走明文；所有资源有硬上限。

### Phase 2：稳定性

- 修 xfer half-close/cancellation/idle。
- listener state machine、真实 Ack/revision、错误重试。
- 修数据竞争和 stale online。
- TLS handshake context；指数退避+jitter；visitor reconnect/resume。
- UDP timer lifecycle。
- 原子状态+备份恢复演练；正确 drain/upgrade。

退出标准：FIN/RST/blackhole/backend hang/EMFILE/磁盘满/进程崩溃都有确定状态和自动恢复。

### Phase 3：性能

- e.take 无限速 fast path，改 token bucket；双向/分层 limiter。
- io.CopyBuffer + bounded pool；UDP buffer pool；减少 per-packet timer/allocation。
- 添加安全隔离的 pprof、Prometheus；先 benchmark/profile 再改。
- 优化 stats 采样，避免每 10 秒复制所有 mapping×sample。

退出标准：完成 Direct/Umbra/frp/nps/Pangolin 矩阵，给出 CPU/byte、memory/conn、p99 和 loss 场景。

### Phase 4：可扩展性

- control 与 data transport 分离。
- node 多 session pool、stream fair scheduling、control priority。
- UDP/弱网采用 QUIC 或真正 packet tunnel，避免 TCP-over-TCP。
- shared durable state、session ownership/lease、gate sharding、HA/LB。
- 多租户 RBAC、node 本地 egress policy、quota/billing boundary。

退出标准：单 node 10k 连接和多 node 100k 连接有明确容量模型；单 gate 故障可自动恢复且配置一致。

### Phase 5：工程与可观测性

- 结构化日志、真实安全审计、metrics/tracing、SLO/alert。
- protocol version/capability/compatibility policy。
- fuzz、race stress、chaos、long soak、upgrade compatibility suite。
- 清理 TypeScript dead control plane，恢复 test/typecheck 全绿。
- SBOM、签名、provenance、漏洞响应和 release support policy。

## 11. 竞品核对来源

- frp releases / v0.71.0：https://github.com/fatedier/frp/releases
- frp network/mux/pool/QUIC：https://gofrp.org/en/docs/features/common/network/network/
- frp TLS/mTLS：https://gofrp.org/en/docs/features/common/network/network-tls/
- frp auth/OIDC：https://gofrp.org/en/docs/features/common/authentication/
- frp server limits/metrics：https://gofrp.org/en/docs/reference/server-configures/
- frp load balancing/health check：https://gofrp.org/en/docs/features/common/load-balancer/
- nps official repository：https://github.com/ehang-io/nps
- nps release history：https://github.com/ehang-io/nps/releases
- nps TLS implementation：https://github.com/ehang-io/nps/blob/master/lib/crypt/tls.go
- nps AES implementation：https://github.com/ehang-io/nps/blob/master/lib/crypt/crypt.go
- Pangolin architecture：https://docs.pangolin.net/development/system-architecture
- Pangolin site credentials：https://docs.pangolin.net/manage/sites/credentials
- Pangolin raw TCP/UDP：https://docs.pangolin.net/manage/resources/public/raw-resources
- Pangolin HA clustering：https://docs.pangolin.net/self-host/advanced/clustering
- Pangolin rate limits：https://docs.pangolin.net/self-host/advanced/config-file
- Pangolin roles：https://docs.pangolin.net/manage/access-control/create-user
- Newt：https://github.com/fosrl/newt
- Gerbil：https://github.com/fosrl/gerbil

## 12. 最终生产判定

当前判定：No-Go。

在以下条件全部满足前，不建议把 umbrad :4400 和动态 entry ports 暴露给不可信公网：

1. 预认证资源放大被消除并有压测/攻击回归。
2. revoke、token expiry/rotation、管理面 TLS 和服务端 session 完成。
3. TCP lifecycle、MaxConns 原子 reservation 和全局限额完成。
4. control state 可原子恢复且损坏 fail closed。
5. mapping validation/端口唯一性和 listener 真实状态完成。
6. 依赖/镜像扫描通过，CI tests/race/typecheck 为绿。
7. 至少完成 10k 连接、slowloris、stream flood、blackhole、重连惊群和 24h soak。

即便完成 P0，单 gate/单 session/UDP-over-TCP 仍会限制它用于高可用、大规模或弱网生产；这些属于 P1/P2/P4 架构工作，而不是简单调大 buffer 就能解决。
