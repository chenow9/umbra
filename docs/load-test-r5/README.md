# r5：10k TCP 稳态

- 日期：2026-08-28
- 发生器：`192.168.10.62`（32 核 / 31GiB / 1GbE）
- Direct：G → `192.168.10.111:19224`（echo）
- Umbra：G → `192.168.10.112:18000` → 隧道 → 111 echo
- 原始文件：`docs/load-test-r5/run/`，obs：`r5-obs-{gate,node,echo}.txt`
- 标记：[Measured] / [Derived] / [Caveat]

## 签什么 / 不签什么

**可以签字：** 在本实验室拓扑下，Umbra 单映射、单 node，10k 条 TCP splice 能建连，并在 60s hold 内保持存活，hold 后 final probe 仍全部成功。Direct 用同一协议先过，所以这不是发生器/echo 过载假阳性。

PASS 条件（每档必须同时满足）：`firstEchoOK=n`、`aliveAtDeadline=n`、`failedDuringHold=0`、`finalProbeOK=n`。

**不能签字：** 吞吐上限、1s 全连接同步 RR、24h soak、多 node、IdleTimeout 关闭后的纯空闲 60s（映射 `IdleTimeoutSec=60`，keepalive 必须短于该值）。

## 协议

交错 keepalive，不是吞吐测试。

| | |
|---|---|
| mode | TCP RR |
| size | 256B |
| interval | 10s，按连接下标把首 ping 铺开；错过的 tick 跳过，不追赶 |
| hold | n=1000 → 20s；n=10000 → 60s |
| timeout | 8s |
| probe | 8s |
| par | 128 |
| hold 截止超时 | 算窗口结束，不算连接死亡 |

上一次同脚本用 `interval=1s` 且无交错：Direct n=1000 已 `STEADY_FAIL`（RTT>interval 后 10k goroutine 打成风暴）；Umbra 建连阶段 `rst`/`eof`（yamux `AcceptBacklog=256` 与 `-par=256` 顶死）。那一档**不能**用来否定稳态。

本轮配套：

- yamux `AcceptBacklog` 256 → 4096（gate 与 node 同时部署）
- `nofile=1048576`，`UMBRA_MAX_SPLICES=20000`
- 映射 `bench-tcp` `:18000` `MaxConns=12000`，`IdleTimeoutSec=60`

## [Measured] 结果

发生器 ulimit=1048576。四档均 `STEADY_PASS`，`RC=0`。

| | n | hold | setup | firstEchoOK | aliveAtDeadline | failedDuringHold | finalProbeOK | holdAttempts | firstEchoRTT p50 / p99 |
|---|---:|---|---:|---:|---:|---:|---:|---:|---|
| Direct | 1000 | 20s | 116ms | 1000 | 1000 | 0 | 1000 | 1995 | 7.7ms / 33.8ms |
| Umbra | 1000 | 20s | 113ms | 1000 | 1000 | 0 | 1000 | 1995 | 10.6ms / 38.4ms |
| Direct | 10000 | 60s | 435ms | 10000 | 10000 | 0 | 10000 | 59950 | 3.2ms / 14.3ms |
| Umbra | 10000 | 60s | 930ms | 10000 | 10000 | 0 | 10000 | 59950 | 9.4ms / 31.7ms |

Umbra n=10000 hold 窗：每连接 5–6 次 echo（p50=6），与 10s interval × 60s 一致。双向应用约 500KiB/s，远低于 1GbE。

obs（cmdline 已校验 `/umbrad`、`umbra-node`、`umbra-bench`）：

Umbra n=10000 hold 期间（21:30:33–21:31:31）：

| | cpu_1s | RSS | fd | sock_fd | host_tcp_est |
|---|---:|---:|---:|---:|---:|
| gate | 建连峰 205.6，hold ≈16–20 | 493–504MB | 10018 | 10012 | 10006 |
| node | hold ≈17–21 | 537–545MB | 10008 | 10002 | 20003 |
| echo-tcp | 峰 88.0 | 65MB | — | 峰 10001 | — |

[Derived] node 上 `host_tcp_est≈20003` 是同机 127.0.0.1 连接两端各计一次（10k node↔echo）加上少量其它套接字，不是 20k 条隧道。gate `sock_fd=10012` 与 10k 公网 TCP + listen/yamux 对齐。

hold 结束后 health `active=0`。gate RSS 仍约 511MB（Go 堆未立刻还给 OS）。echo 在关闭后 `fd` 仍高、`sock_fd=1`，是 echo 进程 FD 残留，不计入 Umbra 稳态结论。

## 复现

```
# 发生器 62
ulimit -n 1048576
OUT=/tmp/r5-steady B=/opt/umbra/umbra-bench bash /opt/umbra/r5-run.sh
```

Direct 同 n 失败则脚本中止，不跑 Umbra。
