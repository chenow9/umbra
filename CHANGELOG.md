# Changelog

## 0.1.2

控制台布局。

- 侧栏入口卡片：节点在线与映射数并排，入/出速率左右排列，右侧不再空
- 映射表、节点表操作列加宽并留出右边距，「…」不再贴边

Console layout.

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
