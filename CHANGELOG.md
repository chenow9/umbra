# Changelog

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
