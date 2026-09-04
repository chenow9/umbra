# Umbra 控制台 2FA 运维指南

从 `v0.1.5` 起，Umbra 的 Web 控制台默认要求管理员口令和 TOTP 双因素认证。本文说明首次绑定、旧版本升级、恢复码、离线重置和环境变量行为。

## 默认行为

- `UMBRA_2FA` 未设置或设为 `on` 时启用 2FA。
- 首次安装必须先设置管理员口令，再绑定 Authenticator；绑定完成前不会签发正式管理会话。
- 日常登录使用口令加六位 TOTP，也可以使用口令加一个未使用的恢复码。
- 支持 1Password、Google Authenticator、Microsoft Authenticator 等标准 TOTP 应用。
- TOTP 依赖时间，入口服务器和手机应启用时间同步。

## 首次安装

1. 通过 SSH 转发或 HTTPS 打开控制台。
2. 设置至少 8 位的管理员口令。
3. 使用 Authenticator 扫描二维码，或手工输入页面上的 TOTP 密钥。
4. 输入应用生成的六位验证码完成绑定。
5. 下载或复制页面展示的 10 个恢复码，并离线保存。

恢复码只显示一次，每个码只能使用一次。关闭页面前没有保存时，可以使用 TOTP 登录，然后在「部署 → 控制台认证」重新生成一组；旧恢复码会全部失效。

## 从旧版本升级

从 `v0.1.4` 或更早版本升级到 `v0.1.5` 及后续版本时：

- 原管理员口令保留；
- 原有管理会话全部失效；
- 入口在 `-tls-dir` 中生成权限为 `0600` 的 `2fa-bootstrap`；
- 首次迁移登录需要原口令和该迁移码，随后必须绑定 Authenticator。

读取迁移码：

```bash
# Docker Compose
docker exec umbrad cat /var/lib/umbra/2fa-bootstrap

# 默认二进制部署路径
sudo cat /var/lib/umbra/2fa-bootstrap
```

迁移码不会打印到日志，绑定成功后文件会被删除。如果部署使用了不同的 `-tls-dir`，请替换上述路径。

## 日常登录与恢复码

- 正常登录：管理员口令 + 当前六位验证码。
- 手机不可用：管理员口令 + 任意一个未使用的恢复码。
- 使用恢复码登录后，该码会立即失效，其他管理会话也会被撤销。
- 登录后可在「部署 → 控制台认证」修改口令、更换 Authenticator 或重新生成恢复码。
- 修改口令、更换绑定或生成恢复码会撤销其他管理会话。

不要把恢复码与管理员口令保存在同一位置。

## 离线重置

只有同时丢失手机和全部恢复码时才需要离线重置。命令必须取得 `tls-dir` 的独占锁，因此应先停止正在运行的 `umbrad`。

二进制或 systemd 部署：

```bash
sudo systemctl stop umbrad
sudo umbrad -reset-2fa -tls-dir /var/lib/umbra
sudo systemctl start umbrad
sudo cat /var/lib/umbra/2fa-bootstrap
```

Docker Compose 部署：

```bash
docker compose -f deploy/compose.gate.yml stop umbrad
docker compose -f deploy/compose.gate.yml run --rm umbrad \
  -reset-2fa -tls-dir /var/lib/umbra
docker compose -f deploy/compose.gate.yml up -d umbrad
docker exec umbrad cat /var/lib/umbra/2fa-bootstrap
```

重置会保留管理员口令，但会删除原 TOTP 绑定和恢复码、撤销全部管理会话，并生成新的迁移码。随后使用原口令和新迁移码重新绑定。

## 环境变量

| 配置                                   | 行为                                         |
| -------------------------------------- | -------------------------------------------- |
| `UMBRA_2FA=on` 或未设置                | 启用 2FA，这是默认值                         |
| `UMBRA_2FA=off`                        | 暂时只验证口令；保留已有绑定                 |
| 其他 `UMBRA_2FA` 值                    | 进程拒绝启动                                 |
| `UMBRA_LOGIN=off`                      | 跳过整个控制台认证，仅用于受控开发或预览环境 |
| 设置 `GROK_AGENT` 或 `GROK_PROJECT_ID` | 同样跳过整个控制台认证，仅用于预览环境       |

修改环境变量后需要重启或重建入口。关闭 2FA 时：

- 不能通过网页更换 TOTP 绑定或重新生成恢复码；
- 如果已有绑定，修改管理员口令仍需当前 TOTP 或恢复码；
- 关闭期间签发的 password-only 会话在重新开启 2FA 后立即失效；
- 原 TOTP 密钥和恢复码不会被删除。

生产环境不建议设置 `UMBRA_2FA=off`，更不能使用会完全跳过登录的预览变量。

## 备份与安全边界

- 备份整个 `-tls-dir`，不要只备份证书文件。
- `control.json` 包含管理员口令哈希、TOTP 对称密钥和恢复码哈希；泄露 `tls-dir` 等同于泄露 TOTP 密钥，并允许离线猜测管理员口令。
- 不要把 `tls-dir`、`2fa-bootstrap`、二维码、TOTP 密钥或恢复码提交到 Git 或发送给不可信第三方。
- TOTP 能抵御密码泄露、撞库和普通暴力破解，但不能抵御实时钓鱼代理。输入验证码前应确认控制台地址和 TLS。
- 若需要更强的抗钓鱼能力，未来可在 TOTP 之外增加 WebAuthn/FIDO2。

实现和安全约束的详细规格见 [2fa-design.md](2fa-design.md)。
