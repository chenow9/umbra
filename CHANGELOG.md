# Changelog

## Unreleased

在多台独立公网入口之间批量导出 / 导入节点和服务配置。

- 控制台可导出选中节点及其服务为带 `schemaVersion` 的 JSON；不含节点凭证、证书私钥、管理认证、访问票据或运行状态
- 导入先预览再写入：每个来源节点可新建（独立身份与一次性凭证）或绑定已有节点；已导入服务默认识别并跳过，更新需查看差异
- 端口冲突沿用入口级监听规则并检查批次内部冲突；持久化失败回滚；保存成功后走现有配置下发与 ACK，离线或监听失败不记为导入失败
- 停用服务保持停用；复制配置不会自动建立内网隧道，新节点仍需部署并连接对应公网入口

Export and import node/service configuration across independent public gateways.

- Export selected nodes and services as versioned JSON without credentials, private keys, console auth, tickets, or runtime status
- Import previews before writing; create a new node identity or bind an existing one; matched services default to skip, with explicit update
- Port conflicts use gateway listen rules and in-batch checks; persist failures roll back; push/ACK after save; offline or listen errors are not import failures
- Disabled services stay disabled; copying config does not create an intranet tunnel

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
