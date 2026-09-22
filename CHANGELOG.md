# Changelog

## Unreleased

- 同一台机器可以安装多个节点。控制台安装命令按节点 ID 分开 systemd、launchd、Windows 服务和 Docker 容器，以及各自的凭证和 CA；多个节点共用一份 `umbra-node` 程序。新命令不会停止旧的固定名服务（`umbra-node`、`io.umbra.node`、`UmbraNode`、容器 `umbra-node`）。用新命令装好后，请手动停掉那一份，避免两个进程同时使用同一次登记。
- Multiple nodes can be installed on one machine. Console install commands give each node id its own systemd unit, launchd job, Windows service, or Docker container, plus its own credential and CA. The nodes share one `umbra-node` binary. New commands leave an older fixed-name install in place (`umbra-node`, `io.umbra.node`, `UmbraNode`, or the `umbra-node` container). Stop that one manually after the new service is running, so two processes do not keep the same enrollment.

## 0.3.2 — 2026-09-21

控制台体验：登录后进入总览，设置、空状态、访问方式与名称校验一并收齐；节点凭证隐藏改为可选。网关协议与安全模型未改。

- 控制台：登录后进入轻量总览（节点在线/总数、服务数、需处理、近期审计）；徽标回到总览，不再进入空的节点列表
- 控制台：导航「系统」改为「设置」（`/settings`，`/deploy` 重定向）；顶栏负责一级分区，观测 / 设置 / 服务详情共用同一套页内二级导航
- 控制台：服务列表展示访问方式标记并可用其筛选；空状态点名凭证访问 / 临时放行 / 公开访问；凭证访问关闭公网业务端口改为中性文案，不再与「需处理」并列成故障
- 控制台：节点、服务、流量、审计空状态统一为图标 + 一句说明 + 可选操作；流量无数据时用同一套空状态（「暂无流量」）而不是裸坐标轴；审计加载中不再闪「没有匹配的记录」；空库与筛选无结果分开，有筛选时可一键清除
- 控制台：登记节点在签发前需确认，取消不会写入节点；改为公开访问需二次确认，取消则保持原访问方式
- 控制台：审计动作合并同义说法并用人话；对象列优先显示节点/服务名称，原始 id 放到提示；操作者不再写 owner；删除后仍能从详情恢复显示名
- 控制台：快速前往与主导航用词对齐，可搜索并打开「全部服务」；浅色与深色共用同一套 lime 主按钮 / 导航选中态；节点离线时探测 / 签发等禁用操作说明原因
- 控制台与 API：节点名称、目标主机、CIDR 以及服务名称（与节点同一字符规则）在提交前校验，`!!!bad` 等无效值无法保存
- 节点凭证隐藏改为可选：入口新增 `--hide-node-token` / `UMBRA_HIDE_NODE_TOKEN`，默认关闭。开启后走文件或环境变量；默认安装命令与本地启动仍使用 `--token`。修改后需重新安装已有节点才能应用
- 中英文 README 首页图改为对应语言版本

Console UX: sign-in lands on a light overview; Settings, empty states, access modes, and name validation are tightened; node credential hiding is opt-in. The gateway protocol and security model are unchanged.

- Console: after sign-in, a light overview shows node online/total, services, attention items, and recent audit; the logo returns there instead of an empty node list
- Console: nav “System” is now “Settings” (`/settings`, `/deploy` redirects); the masthead is top-level location, and Observe, Settings, and service detail share one in-page sub-nav
- Console: service list shows access-mode badges and an access-mode filter; empty states name ticket access, temporary allow, and public access; a closed public business port in ticket access is described as intended, not as a fault
- Console: nodes, services, traffic, and audit share one empty-state pattern; traffic with no samples uses the same icon + “No traffic yet” overlay instead of bare axes; audit loading no longer flashes “no matching records”; empty database vs filtered no-match are distinct, and active filters can be cleared in one click
- Console: enrolling a node requires confirmation before issue; cancel does not create the node; switching to public access requires a second confirm, and cancel keeps the previous mode
- Console: audit actions use one human phrase each; the object column prefers node/service display names with raw ids in the tooltip; actor is administrator/gateway; a name can still be recovered from detail after delete
- Console: Quick Go matches main nav wording and can open All services; light and dark share one lime primary for buttons and the active nav pill; disabled probe/issue actions state why when the node is offline
- Console and API: node names, target hosts, CIDRs, and service names (same character rules as nodes) are validated before save; values such as `!!!bad` are rejected
- Node credential hiding is now opt-in via `umbrad --hide-node-token` / `UMBRA_HIDE_NODE_TOKEN` (default: false). Enabled installations use files or environment variables; default installation commands and local launches use `--token`. Reinstall existing nodes to apply the change
- Localized README hero images for Chinese and English

### 升级说明 / Upgrade notes

升级前备份完整 `tls-dir` 并继续使用原目录。控制数据与流量历史 schema 不变。网关协议与安全模型未改。

0.3.1 起节点凭证默认不出现在命令行；0.3.2 将隐藏改为可选且默认关闭，控制台生成的安装命令默认再次使用 `--token`。若要继续隐藏凭证，在入口设置 `--hide-node-token` 或 `UMBRA_HIDE_NODE_TOKEN=true` 后重新生成安装命令并重装节点。已按 0.3.1 文件 / 环境变量方式部署的节点在重新安装前不受影响。

Back up the complete `tls-dir` and reuse it when upgrading. Control and traffic schemas are unchanged. The gateway protocol and security model are unchanged.

0.3.1 kept node credentials off the command line by default; 0.3.2 makes hiding opt-in and off by default, so console-generated install commands use `--token` again. To keep credentials hidden, set `--hide-node-token` or `UMBRA_HIDE_NODE_TOKEN=true` on the gateway, regenerate the install command, and reinstall the node. Nodes already installed with 0.3.1 file / environment-variable credentials are unchanged until reinstalled.

### 验证说明 / Validation notes

GitHub `main` 在合入 #3–#6 后最新一次 CI（go + binaries）通过。本地 `go vet ./...`、`go test ./internal/control/` 与前端 113 项单测通过。云主机针对流量空状态、审计对象名称、快速前往「全部服务」、服务名称规则（F1–F4）的回归已通过。

GitHub CI on `main` after merging #3–#6 passed (go + binaries). Local `go vet ./...`, `go test ./internal/control/`, and 113 frontend unit tests passed. Cloud-host regression of F1–F4 (traffic empty state, audit object names, Quick Go All services, service-name rules) passed.

[完整改动 / Full diff](https://github.com/chenow9/umbra/compare/v0.3.1...v0.3.2)

## 0.3.1 — 2026-09-14

安全加固与数据面性能优化：堵住临时放行、凭证访问与登录限流上的若干口子，降低控制台与 UDP 路径的锁竞争与分配开销。

- 安全：临时放行不再把空来源 IP 退化为“任意来源”。管理口绑定 Unix socket 或反代未传来源 IP 时，敲门接口返回 400 并要求显式指定 `ip`；nftables 与用户态检查都不再接受通配放行；热升级不再回放旧版无来源 IP 的放行记录
- 限速改为令牌桶节流：TCP 连接超出 `rateKbps` 时按速率延后发送而不是直接断开，且上下行都受限；UDP 两个方向超出预算时丢包并计入 `traffic_limit` 丢弃统计
- 安全：吊销票据、票据到期、服务停用 / 删除或退出凭证访问模式时，立即断开该票据 / 服务下已建立的访问端会话，不再等待客户端自行断线
- 安全：审计记录区分 `owner` 与 `gateway` 两类来源；环满时优先淘汰网关自动产生的事件，未认证流量（ACL 拒绝、节点抖动）无法把管理员操作挤出审计历史。ACL 拒绝每个服务每分钟最多写一条审计并折叠计数，TCP 拒绝日志每服务每秒最多一条
- 修复服务配置热更新与数据面读取之间的数据竞争：入口现在以不可变快照方式持有配置，连接 / 报文处理不再加全局锁读取；`allowCidrs` 在配置变更时解析一次，不再逐连接、逐报文重复解析 CIDR 文本
- 隧道每流接收窗口从 256 KiB 提升到 2 MiB：单条 TCP 连接在 100 ms 往返下的吞吐上限从约 20 Mbit/s 提升到约 160 Mbit/s，公网入口、节点与访问端需同时升级才能生效
- UDP 数据面收发路径减少复制与分配：AEAD 密钥调度按方向缓存而不是逐包重建，封包在池化缓冲中原地加密、解包原地解密，入口与独立 UDP 通道的读缓冲不再逐包复制；封包 + 解包基准从约 2.2 µs / 13 次分配降到约 1.0 µs / 6 次分配
- 控制台后台采样不再阻塞数据面：审计回调改为带缓冲的异步投递（满时丢弃并计数），入口连接 / 报文处理不再等待控制台加锁写审计；流量样本的 JSON 序列化移出全局锁，`traffic` 文件与 `control.json` 一起每分钟落盘一次而不是每 10 秒 fsync 一次，正常退出仍会完整刷盘
- 安全：登录全局退避只对近期失败过的 IP 生效。攻击者用少数 IP 持续喂错口令，不再能让管理员从未失败过的 IP 也收到 429；分布式猜测仍受每 IP 8 次 / 15 分钟和 2 路并行口令哈希的约束
- 安全：控制台增加 `Content-Security-Policy`、`X-Frame-Options: DENY` 与 `Strict-Transport-Security`。API 响应禁止加载任何资源；HTML 文档按所服务文件计算内联脚本哈希写入 `script-src`，不使用 `'unsafe-inline'` 脚本，`frame-ancestors 'none'` 阻止点击劫持；HSTS 仅在经 TLS 直连或可信反代报告 https 时返回，纯 HTTP 回环不会污染浏览器的 HSTS 缓存
- 安全：节点凭证不再出现在任何命令行上。`umbra-node` 新增 `--token-file` / `UMBRA_TOKEN_FILE`；Windows 安装脚本把凭证写入仅 SYSTEM 与 Administrators 可读的 `ProgramData\Umbra\node.token` 并以路径传给服务，不再放进 `sc qc` 可见的服务命令行；Docker 安装脚本把凭证写入 0600 文件并只读挂载，不再作为容器参数出现在 `docker inspect` 中；控制台本地拉起节点时凭证走环境变量而非 argv
- 安全：控制台探测临时放行服务时只为 127.0.0.1 开 3 秒窗口，而不是服务的完整放行时长；敲门不再缩短同一地址已有的更长放行
- 安全：凭证访问的 TCP 流转发到节点时，`peer_ip` / `peer_port` 改为公网入口实际接受访问端连接的地址，不再透传访问端自报（可伪造）的值；UDP 保留访问端提供的值作为流标识
- 文档：安全模型一节补充 CA 私钥不落盘的事实与轮换流程、登录退避在反代配置错误时的可用性风险、临时放行对 IPv6 来源只做用户态拒绝及对应的规避方式；修正此前“`tls-dir` 含 CA 私钥”的不准确描述；节点凭证传递方式改为环境变量 / `--token-file`

Security hardening and data-plane performance work: close gaps around Temporary allow, Ticket access and login rate limiting, and cut lock contention and allocations on the console and UDP paths.

- Security: Temporary allow no longer widens an empty source IP into an any-source grant. When the console is bound to a Unix socket or a proxy passes no client IP, the knock API returns 400 and requires an explicit `ip`; neither the nftables nor the userspace check accepts a wildcard grant; hot upgrades no longer replay legacy grants that lack a source IP
- Rate limiting is now a token-bucket shaper: TCP streams exceeding `rateKbps` are paced instead of torn down, and both directions are limited; UDP drops over-budget packets in both directions and counts them under `traffic_limit`
- Security: Revoking a ticket, ticket expiry, and disabling / deleting a service or moving it out of Ticket access now immediately disconnect the visitor sessions admitted under it instead of waiting for the client to drop
- Security: Audit records now distinguish `owner` from `gateway` actors; when the ring is full, gateway-generated events are evicted first so unauthenticated traffic (ACL drops, node flapping) cannot push administrator actions out of the history. ACL drops produce at most one audit record per service per minute with a folded count, and TCP drop log lines are limited to one per service per second
- Fix a data race between hot service updates and the data plane: entries now hold their configuration as an immutable snapshot that connection and packet handlers read without the global lock; `allowCidrs` is parsed once per update instead of re-parsing CIDR text for every connection and packet
- Tunnel per-stream receive window raised from 256 KiB to 2 MiB: a single TCP connection at 100 ms RTT goes from roughly 20 Mbit/s to roughly 160 Mbit/s; gateway, nodes and visitor clients must all be upgraded to benefit
- Fewer copies and allocations on the UDP data plane: the AEAD key schedule is cached per direction instead of rebuilt per packet, datagrams are sealed in place in a pooled buffer and opened in place, and neither the entry socket nor the independent UDP channel copies its read buffer per packet; the seal + open benchmark drops from about 2.2 µs / 13 allocations to about 1.0 µs / 6 allocations
- Console background sampling no longer stalls the data plane: audit callbacks are delivered asynchronously through a bounded queue (dropped and counted when full), so connection and packet handlers never wait on the console lock to write audit records; traffic sample JSON encoding runs outside the global lock, and the `traffic` file is persisted together with `control.json` once a minute instead of fsyncing every 10 seconds, with a full flush still performed on clean shutdown
- Security: The global login backoff now only applies to addresses with a recent failure. An attacker feeding wrong passwords from a few addresses can no longer make the administrator receive 429 from an address that has never failed; distributed guessing remains bounded by the 8 attempts / 15 minutes per-address budget and the two-way password hash concurrency limit
- Security: The console now sends `Content-Security-Policy`, `X-Frame-Options: DENY` and `Strict-Transport-Security`. API responses may load nothing at all; HTML documents get a policy whose `script-src` carries SHA-256 hashes of the inline scripts computed from the served file, so no `'unsafe-inline'` script is allowed, and `frame-ancestors 'none'` blocks clickjacking. HSTS is only sent when the request arrived over TLS directly or via a trusted proxy reporting https, so a plain-HTTP loopback console never poisons the browser's HSTS cache
- Security: Node credentials no longer appear on any command line. `umbra-node` gains `--token-file` / `UMBRA_TOKEN_FILE`; the Windows install script writes the credential to `ProgramData\Umbra\node.token`, readable only by SYSTEM and Administrators, and passes the path instead of putting the secret in the service command line visible through `sc qc`; the Docker install script writes it to a 0600 file and mounts it read-only instead of passing it as a container argument visible through `docker inspect`; the console's local node spawn passes it through the environment rather than argv
- Security: The console's reachability probe opens the Temporary allow service to 127.0.0.1 for 3 seconds instead of the service's full allow TTL; a knock never shortens an existing longer grant for the same address
- Security: TCP streams admitted through Ticket access are forwarded to the node with `peer_ip` / `peer_port` set to the address the gateway actually accepted the visitor from, instead of the visitor's self-reported and spoofable values; UDP keeps the visitor-supplied values as a flow key
- Docs: The security model section now covers the fact that the CA private key is never stored and how to rotate, the availability risk of the login backoff behind a misconfigured proxy, and that Temporary allow only rejects IPv6 sources in user space along with how to avoid that; corrects the earlier inaccurate statement that `tls-dir` contains the CA private key; node credential examples use the environment / `--token-file`

### 升级说明 / Upgrade notes

升级前备份完整 `tls-dir` 并继续使用原目录。控制数据与流量历史 schema 不变。隧道每流窗口从 256 KiB 提到 2 MiB，公网入口、节点与访问端需同时升级才能吃到吞吐提升。Windows / Docker 节点若仍用旧安装脚本，请重新执行控制台生成的安装命令，使凭证改走文件而不是命令行；已在跑的 Linux / macOS 节点凭证本来就不在 argv 上，可按需轮换。`umbra-node` 的 `--token` 仍可用，但推荐 `--token-file` 或 `UMBRA_TOKEN`。

Back up the complete `tls-dir` and reuse it when upgrading. Control and traffic schemas are unchanged. The per-stream tunnel window rises from 256 KiB to 2 MiB, so gateway, nodes and visitor clients must all be upgraded to benefit. Windows / Docker nodes still installed with the old scripts should re-run the console-generated install command so the credential moves into a file instead of the command line; Linux / macOS nodes already kept the credential off argv and only need a rotate if desired. `umbra-node --token` still works; prefer `--token-file` or `UMBRA_TOKEN`.

### 验证说明 / Validation notes

本地 `go vet ./...` 与 `go test -race ./...` 通过；控制台安全头相关用例、登录退避、登记脚本、访问端 PeerIP 覆盖与敲门不缩短已有放行等回归通过；前端 `units.test.ts` 通过。内嵌控制台在浏览器中完成了初始化、2FA 绑定（含 QR）、恢复码、节点页与流量图，CSP 无违规。

Local `go vet ./...` and `go test -race ./...` passed, including regressions for console security headers, login backoff, enrollment scripts, visitor PeerIP override, and knocks that must not shorten an existing grant. Frontend `units.test.ts` passed. The embedded console completed setup, 2FA enrollment (including the QR code), recovery codes, the node list and the traffic charts in a browser with no CSP violations.

[完整改动 / Full diff](https://github.com/chenow9/umbra/compare/v0.3.0...v0.3.1)

## 0.3.0 — 2026-09-11

在多台独立公网入口之间批量导出 / 导入节点和服务配置。

- 控制台可导出选中节点及其服务为带 `schemaVersion` 的 JSON；不含节点凭证、证书私钥、管理认证、访问票据或运行状态
- 导入先预览再写入：每个来源节点可新建（独立身份与一次性凭证）或绑定已有节点；已导入服务默认识别并跳过，更新需查看差异
- 端口冲突沿用入口级监听规则并检查批次内部冲突；持久化失败回滚；保存成功后走现有配置下发与 ACK，离线或监听失败不记为导入失败
- 停用服务保持停用；复制配置不会自动建立内网隧道，新节点仍需部署并连接对应公网入口
- 修复切换导入目标节点后沿用旧的跳过操作导致漏导入服务，以及导入无服务节点时的空列表崩溃
- 导入的空闲超时、连接数和限速校验与创建 / 更新对齐，合法的大数值配置可完整导出再导入
- 修复内嵌控制台静态资源目录可被列出的问题；相关测试不再依赖 Git 忽略的构建资源
- 将 CI 漏洞扫描工具固定为兼容 Go 1.25 的 govulncheck v1.7.0，修复上游 latest 升级要求 Go 1.26 后的安装失败
- 调整登录页语言控件的背景与布局，将登录中心标识改为圆形月食图案
- 中英文 README 与控制台统一使用节点、服务、凭证访问、临时放行和公开访问；保留 API / 协议技术名称对照
- README 加入三种访问方式的本地循环 GIF 和 Release 下载量徽章，部署示例更新为 0.3.0
- 增加 GitHub Linguist 配置，将配套 UI 源码排除出语言占比并标记内嵌 UI 构建产物，突出 Go 核心

Export and import node/service configuration across independent public gateways.

- Export selected nodes and services as versioned JSON without credentials, private keys, console auth, tickets, or runtime status
- Import previews before writing; create a new node identity or bind an existing one; matched services default to skip, with explicit update
- Port conflicts use gateway listen rules and in-batch checks; persist failures roll back; push/ACK after save; offline or listen errors are not import failures
- Disabled services stay disabled; copying config does not create an intranet tunnel
- Fix stale skip actions omitting services after changing import targets, and empty service lists crashing the import preview
- Align import validation for idle timeouts, connection limits, and rate limits with create/update rules so valid large values round-trip intact
- Prevent directory listings for embedded console assets; remove test dependencies on Git-ignored build assets
- Pin the CI vulnerability scanner to govulncheck v1.7.0 for Go 1.25 compatibility, fixing installation after upstream latest began requiring Go 1.26
- Refine the login language control's background and layout, and use a circular eclipse mark at the center of the login screen
- Align both READMEs and console wording around nodes, services, Ticket access, Temporary allow, and Public access, with API/protocol terminology references
- Add local looping GIFs for all three access flows and release download badges to the READMEs; update deployment examples to 0.3.0
- Configure GitHub Linguist to exclude companion UI sources from language statistics and mark embedded UI build output as generated, highlighting the Go core

### 升级说明 / Upgrade notes

升级前备份完整 `tls-dir` 并继续使用原目录。配置导出仅用于复制节点和服务，不是完整备份，不包含身份凭证或认证状态；新建的目标节点需要独立部署。API 路径、协议名称和 `visitor` / `spa` / `public` 配置值不变。

Back up the complete `tls-dir` and reuse it when upgrading. Configuration exports copy nodes and services; they are not full backups and omit credentials and authentication state. Newly created target nodes require separate deployment. API paths, protocol names, and the `visitor` / `spa` / `public` mode values are unchanged.

### 验证说明 / Validation notes

本地 Go 全量测试、vet、race、TypeScript 类型检查、100 项前端测试与内嵌控制台构建通过。服务冒烟覆盖节点登记、TCP / UDP、三种访问方式、探测失败、访问凭证生命周期、服务启停删除，以及真实停机重启后的流量持久化。全仓 `npm test` 的脚本阶段仍有 18 项模板测试失败；已独立运行 v0.2.0 对照，失败项完全一致，后续前端测试已单独运行通过。

Local Go tests, vet/race, TypeScript type checking, all 100 frontend tests, and the embedded console build passed. Service smoke checks cover node enrollment, TCP/UDP, all three access modes, probe failures, ticket lifecycle, service enable/disable/delete, and traffic persistence across an actual shutdown and restart. The script stage of the full `npm test` command still has 18 template failures, identical to an independently tested v0.2.0 baseline; the subsequent frontend tests were run separately and passed.

[完整改动 / Full diff](https://github.com/chenow9/umbra/compare/v0.2.0...v0.3.0)

## 0.2.0

节点优先的控制台重构、完整认证入口与服务访问流程。

- 控制台以节点和服务为中心组织导航：首页进入节点列表，新增节点服务视图，流量与审计共享观测入口和筛选范围
- 重构服务创建、编辑与连接流程；新建服务默认使用凭证访问，按访问方式提供连接信息、访问命令和票据管理
- 统一桌面与手机布局、月食标识及明暗主题，新增快速查找；修复完整操作名称无法被搜索的问题
- 新增中文 / English，默认跟随浏览器，手动选择后保存偏好；登录、首次设置、验证器绑定和恢复码页面统一视觉与文案，错误提示按认证状态本地化
- 服务创建返回完整状态，并拒绝在已吊销节点上创建服务；就绪状态要求配置确认，入口地址使用网关公布地址
- 探测必须收到目标响应才算成功，记录无响应等失败原因；禁止探测已停用服务，配置变更后不会误用旧目标的探测结果
- 停机和热升级刷新流量曲线后立即保存累计流量，避免约 60 秒保存周期内尚未落盘的计数丢失
- 移除失效的旧前端控制与转发实现，补充认证、控制台、服务流程、真实停机重启和跨版本升级回归
- 完善可信反向代理部署说明，中英文 README 增加 MoonProxy 和 Lantunnel 相关项目

A node-first console, a complete authentication entry, and clearer service access workflows.

- Organize navigation around nodes and services: open the node list by default, add per-node service views, and share observation navigation and scope between traffic and audit
- Rebuild service creation, editing, and connection flows; default new services to credential-based visitor access, with mode-specific connection details, commands, and ticket management
- Unify desktop/mobile layouts, eclipse branding, and light/dark themes; add quick search and fix matching by the full visible action name
- Add Chinese and English with browser-language defaults and saved preferences; refresh sign-in, setup, authenticator enrollment, and recovery-code screens with state-aware localized guidance
- Return the full service view on creation and reject revoked nodes; require configuration acknowledgement for readiness and derive entry addresses from the advertised gateway address
- Require a target response for a successful probe, record failure details, reject disabled services, and discard probe results from outdated configurations
- Persist cumulative traffic immediately after flushing the series on shutdown and hot upgrade, retaining counters from the latest control-data save interval
- Remove obsolete frontend control/forwarding implementations and add authentication, console, service, shutdown/restart, and cross-version regression coverage
- Document trusted reverse proxies and add MoonProxy and Lantunnel to both READMEs

### 升级说明 / Upgrade notes

升级前备份完整 `tls-dir`（CA / 证书、`control.json`、`.prev`、`.tomb`、`traffic`），继续使用原目录。控制数据 schema 2、流量历史 schema 1 不变；已验证 v0.1.5 合成数据的升级和回退。TOTP 仍默认开启。跨版本试验未覆盖真实账户会话与 2FA 的端到端迁移，不代表支持任意旧版本回退。

Back up the complete `tls-dir` and reuse it when upgrading. Control schema 2 and traffic schema 1 are unchanged; upgrade and rollback were checked with synthetic v0.1.5 data. TOTP remains enabled by default. The cross-version test does not establish end-to-end migration of real account sessions/2FA or rollback support for arbitrary older releases.

### 验证说明 / Validation notes

Go 全量测试、vet、race，94 项前端 TypeScript 测试，生产与跨平台构建，认证/控制台浏览器回归，转发/热升级 30 项，60 秒稳定性检查以及流量停机持久化检查通过。全仓 `npm test` 仍有 18 项与旧 main 一致的模板测试失败，构建前 lint 有 1 项相同的历史错误；不能视为所有检查全绿。详细范围见 [合并前回归报告](https://github.com/chenow9/umbra/blob/v0.2.0/docs/product-review/premerge-regression-2026-09-07.md)。

Go tests, vet/race, all 94 frontend TypeScript tests, production/cross-platform builds, authentication/console browser checks, 30 forwarding/hot-upgrade checks, a 60-second stability run, and shutdown persistence checks passed. The full npm test command still has 18 template failures matching the previous main baseline, and pre-build lint has one matching historical error. See the linked regression report for coverage and limits.

## 0.1.5

控制台强制 TOTP 双因素认证。

- 新安装在获得正式会话前必须绑定 Authenticator，并保存一次性恢复码
- 从 schema 1 升级时撤销旧管理会话，并要求服务器本地 `{tls-dir}/2fa-bootstrap` 迁移码后才能绑定
- 日常登录同时验证口令与 TOTP 或恢复码；关闭 2FA 期间的 password-only 会话在重新开启后失效
- 关闭 2FA 不能远程改绑定；解绑只能使用 `umbrad -reset-2fa`
- `UMBRA_2FA` 默认 `on`，非法值拒绝启动；`GROK_AGENT` / `GROK_PROJECT_ID` / `UMBRA_LOGIN=off` 仍会跳过整个认证并打警告
- 密码与 TOTP 校验限制并发和尝试频率；口令、绑定或恢复状态变化会撤销旧会话与 pending 凭证
- 认证状态通过 tomb 防止备份回滚；`tls-dir` 在读取状态前加锁，热升级会先排空 HTTP/SSE 再交接锁
- 修复旧用户升级后首次提交口令和迁移码时页面仍停在登录表单；现在无需刷新即可进入 Authenticator 绑定

Console authentication now requires TOTP by default.

- New installs must enroll an authenticator and save one-time recovery codes before a console session is issued
- Schema 1 upgrades revoke previous admin sessions and require the local `{tls-dir}/2fa-bootstrap` migration code before enrollment
- Daily login checks the password plus TOTP or a recovery code; password-only sessions minted while 2FA is off stop working when it is turned back on
- Remote rebinding is denied while 2FA is off; unbinding is only available via `umbrad -reset-2fa`
- `UMBRA_2FA` defaults to `on` and refuses illegal values; `GROK_AGENT` / `GROK_PROJECT_ID` / `UMBRA_LOGIN=off` still skip all console auth and log a warning
- Password and TOTP verification limit concurrency and attempt rates; password, binding, or recovery changes revoke old sessions and pending credentials
- An authentication tomb prevents backup rollback; `tls-dir` is locked before loading state, and hot upgrades drain HTTP/SSE before handing off the lock
- Fix upgraded users remaining on the login form after submitting their password and migration code; authenticator enrollment now opens without a refresh

## 0.1.4

健康检查收敛、流量时间窗口修复与发布完善。

- 公网 `/health` 仅返回整体 `ok` 状态并保留 `200/503` 探针语义，不再暴露连接数、流量、丢包和限流配置
- 新增登录后可访问的 `/v1/health` 详细诊断接口，健康响应禁止缓存，并补充认证与字段回归测试
- 修复实时流量序列被 2500 点截断的问题，1 小时、24 小时和 7 天窗口现在保留并裁剪各自范围的数据
- 流量图改用固定所选窗口的 ECharts 时间轴与显示抽稀，避免 24 小时和 7 天视图退化为相同的短时段
- Docker 部署文档和 compose 示例固定到当前正式版本，避免生产环境跟随 `latest` 意外升级
- 项目许可由私有保留权利声明改为 Apache License 2.0

Health-check hardening, correct traffic windows, and release cleanup.

- Keep the public `/health` response to the aggregate `ok` state while preserving `200/503` probe semantics; connection, traffic, drop, and admission details are no longer exposed
- Add authenticated `/v1/health` diagnostics, disable health-response caching, and cover public, unauthorized, and authenticated behavior with regression tests
- Stop truncating live traffic series to 2,500 points so the 1-hour, 24-hour, and 7-day views retain and trim data to their actual windows
- Move traffic charts to ECharts time axes locked to the selected range with display downsampling, preventing the 24-hour and 7-day views from collapsing to the same short interval
- Pin Docker deployment documentation and compose examples to the current stable release instead of allowing production deployments to drift with `latest`
- Replace the private all-rights-reserved notice with the Apache License 2.0

## 0.1.3

跨平台发布、节点系统服务与控制台部署流程。

- CI 构建并上传 Linux、macOS、Windows 的 amd64 / arm64 二进制文件
- 节点登记按所选平台生成可直接执行的系统服务命令：Linux systemd、macOS launchd、Windows Service
- `umbra-node` 支持 Windows Service Control Manager，并在停止服务时正常关闭隧道和重试循环
- Windows 安装改用 PowerShell `New-Service`，增加管理员权限、服务删除等待和失败退出码检查
- 节点命令选择正确架构的二进制，内嵌入口 CA 和凭证；终端关闭或系统重启后节点继续运行
- Docker 节点命令可重复执行，会替换已有容器并保留自动重启策略
- 部署页只生成填写了真实入口地址的命令；节点和访问端命令回到登记、签发流程，移除演示入口和占位内容
- 中英文文档补充 Linux、macOS、Windows 节点服务的状态、停止、启动、禁用和卸载命令

Cross-platform releases, node system services, and a clearer console deployment flow.

- Build and upload Linux, macOS, and Windows binaries for amd64 and arm64 in CI
- Generate ready-to-run native node services for the selected platform: systemd, launchd, or Windows Service
- Add Windows Service Control Manager support to `umbra-node`, including graceful tunnel and retry-loop shutdown
- Use PowerShell `New-Service` on Windows with administrator, deletion-wait, and native exit-code checks
- Select the correct node binary architecture and embed the gate CA and credential; nodes survive terminal close and host reboot
- Make the Docker node command repeatable by replacing an existing container while retaining its restart policy
- Generate gate commands only after a real address is supplied; move node and visitor commands back to enrollment/issuance and remove demo placeholders
- Document node service status, stop, start, disable, and uninstall operations for Linux, macOS, and Windows in both READMEs

## 0.1.2

UDP 稳定性、可观测性与控制台布局。

- uplane 发送改为有序分配序号、编码并写入，避免高并发乱序被重放窗口误判
- UDP socket 接收缓冲支持 `UMBRA_UDP_READ_BUFFER`，默认 512 KiB，覆盖 gate、node 和 visitor
- gate 映射/API 与 node 日志增加 UDP 分段计数，可区分入口、uplane、目标和客户端回写问题
- 补充入口容量、UDP flow 准入和接收缓冲环境变量文档
- 侧栏入口卡片：节点在线与映射数并排，入/出速率左右排列，右侧不再空
- 映射表、节点表操作列加宽并留出右边距，「…」不再贴边

UDP stability, observability, and console layout.

- Serialize uplane sequence allocation, encoding, and socket writes so concurrent traffic is not misclassified by the replay window
- Add `UMBRA_UDP_READ_BUFFER` for gate, node, and visitor UDP sockets with a conservative 512 KiB default
- Add gate mapping/API and node-log UDP stage counters to separate ingress, uplane, target, and client-write issues
- Document gate capacity, UDP flow admission, and receive-buffer environment variables
- Sidebar entry card: node online and mapping counts sit side by side; inbound/outbound rates in two columns so the right side is not empty
- Mapping and node tables widen the action column and add right padding so the ⋯ menu is not flush with the card edge

## 0.1.1

侧栏入口速率。

- 入站、出站左右并排，长数字不再把箭头挤到下一行
- ↓ 入站绿、↑ 出站棕，与图表图例一致

Sidebar entry rates.

- Inbound and outbound sit side by side so long numbers no longer wrap the arrows
- ↓ inbound is green, ↑ outbound is amber, matching the chart legend

## 0.1.0

控制台流量图与映射页。

- 实时图表改为时间轴，末尾平滑更新，显示时抽稀，避免点过密
- 新建映射默认 `public`
- 映射表：名称列不再折成三行；流量入/出分行；配额与丢弃不再从词中间断开
- 限速可切换 KB/s、MB/s、Mbps，并对照换算
- 丢弃文案改为「当时节点离线」，避免理解成节点现在离线
- 限速单位下拉与协议/模式同一套样式

Console traffic charts and mappings page.

- Live charts use a time axis, a smooth tail, and display downsample so points are not too dense
- New mappings default to `public`
- Mappings table: name column no longer wraps to three lines; inbound/outbound traffic stack; quota and drop text no longer break mid-phrase
- Rate limits switch among KB/s, MB/s, and Mbps with a live conversion
- Drop copy is “node was offline then”, not that the node is offline now
- Rate-limit unit dropdown uses the same control as protocol and mode
