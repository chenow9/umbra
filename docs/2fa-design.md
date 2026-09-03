# Umbra 控制台强制 2FA 设计与开发规格

状态：已实现；本文保留为设计、安全约束与回归验收依据
目标读者：负责开发、测试和审查该功能的工程师或代码代理
适用范围：Umbra 单管理员控制台认证，不涉及 Node、Visitor 或 Better Auth/OAuth

## 1. 背景

Umbra 当前使用 Go 控制台内置的单管理员口令认证：

- `POST /v1/setup` 首次设置管理员口令；
- `POST /v1/login` 验证口令；
- 验证成功后签发 `umbra_owner` 会话 Cookie；
- 会话和管理员认证状态保存在 `control.json`；
- `control.json.prev` 和 `control.json.tomb` 用于损坏恢复及安全状态防回滚；
- `UMBRA_LOGIN=off` 可以关闭整个控制台认证。

本功能需要在这条认证链路中加入默认强制的双因素认证，而不是修改前端模板中独立的 Better Auth/OAuth 代码。

## 2. 已确定的产品决策

除非产品负责人另行修改，开发应采用以下默认方案，不需要在实现过程中重新猜测：

1. 第二因素使用 RFC 6238 TOTP，即 Authenticator 六位动态验证码。
2. 2FA 默认开启，通过 `UMBRA_2FA=off` 才能明确关闭。
3. 新安装必须依次完成密码设置、TOTP 绑定和首次验证码确认，之后才能获得正式会话。
4. 旧版本升级后保留原密码，但升级前的所有管理会话立即失效；下次登录强制绑定 TOTP。
5. 日常登录必须在同一次认证中同时验证密码和 TOTP，或密码和一次性恢复码。
6. 生成 10 个一次性恢复码；只保存哈希，明文只展示一次。
7. TOTP、密码或恢复机制变化时撤销旧会话，并通过认证代际阻止旧会话重新生效。
8. 提供只能在服务器本地执行的离线 2FA 重置命令。
9. 关闭 2FA 不删除原绑定；重新开启后继续使用原绑定，并拒绝关闭期间签发的 password-only 会话。
10. 旧用户首次迁移绑定支持本地一次性迁移码，防止已经获得旧密码的远程攻击者抢先绑定。
11. 关闭 2FA 的窗口内禁止远程改绑定：不能更换 TOTP、不能重置 2FA、不能重生恢复码；若已有绑定，改口令仍须验证当前 TOTP 或恢复码。
12. 不提供在线“关闭/解绑 2FA”接口。解绑只能通过服务器本地 `umbrad -reset-2fa`。
13. `src/lib/auth` 与 Better Auth/OAuth 是 Grok PWA 模板，不是控制台认证。禁止把它接到 `/v1/setup`、`/v1/login` 或 `umbra_owner`。

## 3. 目标与非目标

### 3.1 目标

启用 2FA 时，任何正式控制台会话都必须满足：

```text
有效密码 + 已绑定且有效的第二因素
```

系统必须保证：

- 只验证密码不会获得正式管理权限；
- 未确认的 TOTP 绑定不会生效；
- 旧版本会话不能绕过新版本的 2FA；
- 临时关闭 2FA 时创建的会话不能在重新开启后继续使用；
- 已使用的 TOTP 时间片和恢复码不能重放；
- `.prev` 恢复不能复活旧密钥、旧会话或已用恢复码；
- 持久化失败时不签发会话；
- 管理员丢失手机后仍有受控的恢复路径。

### 3.2 非目标

第一版不实现：

- 短信验证码；
- 邮件验证码；
- 推送确认；
- 多管理员或多账号；
- “记住此设备”或跳过 2FA；
- Passkey/WebAuthn。

WebAuthn/FIDO2 具有更强的抗实时钓鱼能力，可以作为未来版本。TOTP 可以显著抵御密码泄露、撞库和普通暴力破解，但不抵御实时钓鱼代理。

## 4. 当前代码入口

开发前应重点检查以下文件，并保持现有安全不变量：

- `cmd/umbrad/main.go`：启动参数、环境变量、控制台初始化、热升级；
- `internal/control/control.go`：密码、持久化、会话和防回滚状态；
- `internal/control/http.go`：认证 API、Cookie、Origin 检查；
- `internal/control/httpbind.go`：TLS、可信反向代理和客户端 IP；
- `internal/control/control_test.go`：认证、持久化和会话回归测试；
- `src/lib/umbra/api.ts`：前端 API 客户端；
- `src/components/pages/login-page.tsx`：登录和首次设置界面；
- `src/components/app-shell.tsx`：未登录跳转；
- `src/components/umbra-live.tsx`：登录状态与事件流；
- `deploy/compose.gate.yml`、`README.md`、`README.en.md`：部署及升级说明。

## 5. 认证状态机

系统至少需要表达以下状态：

| 状态 | 密码 | 2FA | 正式会话 | 前端行为 |
| --- | --- | --- | --- | --- |
| `auth_disabled` | 任意 | 忽略 | 不要求 | 直接进入 |
| `unconfigured` | 未设置 | 未绑定 | 无 | 设置密码 |
| `enrollment_required` | 已设置 | 未确认 | 无 | 验证密码后绑定 |
| `ready` | 已设置 | 已确认 | 无 | 密码 + TOTP 登录 |
| `authenticated` | 已设置 | 已确认 | 有效 MFA 会话 | 进入控制台 |
| `recovery_required` | 已设置 | 设备丢失 | 无 | 密码 + 恢复码 |

认证流程：

```text
密码验证成功
    ├─ 2FA 关闭：签发 password-only 会话
    ├─ 2FA 开启但未绑定：只签发短期 enrollment 凭证
    └─ 2FA 开启且已绑定：
         ├─ TOTP 验证成功：签发 MFA 会话
         └─ 恢复码验证成功：消费恢复码后签发 MFA 会话
```

enrollment 凭证只能访问绑定接口，不能通过任何现有 `c.need(...)` 保护的 API。

## 6. 环境变量

新增：

```text
UMBRA_2FA=on       # 默认值
UMBRA_2FA=off      # 明确关闭
```

解析规则：

- 未设置或空值等价于 `on`；
- 忽略首尾空白并允许大小写差异；
- 只接受 `on` 和 `off`；
- 其他值必须拒绝启动，不能静默回退；
- 以下任一条件都会跳过整个控制台认证（含 2FA），优先级高于 `UMBRA_2FA`：
  - `UMBRA_LOGIN=off`
  - `GROK_AGENT` 非空
  - `GROK_PROJECT_ID` 非空
- `GROK_AGENT` / `GROK_PROJECT_ID` 只用于预览与 Agent 环境，生产入口不得设置；
- 当整个认证被跳过，或 `UMBRA_2FA=off` 时，启动日志必须输出醒目警告；
- 环境变量只决定当前是否强制验证 2FA，不持久化、不删除已有 TOTP 密钥。
- 解析在启动时进行一次，结果传入 `Console`，请求路径不得再读环境变量。

在 `deploy/compose.gate.yml` 中增加：

```yaml
environment:
  UMBRA_2FA: ${UMBRA_2FA:-on}
```

启动时解析一次并传入 `Console`，不要在请求路径中反复读取环境变量：

```go
type Console struct {
    // existing fields...
    SkipAuth         bool
    RequireTwoFactor bool
}
```

## 7. TOTP 规格

采用以下参数，以兼容 1Password、Google Authenticator、Microsoft Authenticator 等常见应用：

```text
算法：HMAC-SHA1
密钥：20 个 crypto/rand 随机字节，即 160 bit
编码：无填充 Base32
验证码位数：6
周期：30 秒
允许时间窗口：当前 counter ±1
Issuer：Umbra
Account：owner@<访问主机名>
```

示例 URI：

```text
otpauth://totp/Umbra:owner%40gate.example.com?secret=BASE32SECRET&issuer=Umbra&algorithm=SHA1&digits=6&period=30
```

实现要求：

- 使用 `crypto/rand` 生成密钥；
- issuer 和账号标签必须正确 URL 编码；
- TOTP 密钥、二维码 URI、验证码禁止写日志和审计；
- 提供 Base32 手工密钥，不能只提供二维码；
- 二维码及绑定信息响应必须带 `Cache-Control: no-store`；
- 记录最后成功使用的 counter，同一个时间片只能成功一次；
- 并发提交同一验证码时最多一个请求成功；
- 主机时钟偏差超过允许窗口时，前端提示检查 NTP/系统时间；
- 使用 RFC 6238 官方测试向量验证算法实现。

建议将纯算法放在 `internal/control/totp.go`，保持无 HTTP 和持久化依赖，便于单元测试。

## 8. API 设计

### 8.1 `GET /v1/auth`

保留现有字段，并增加 2FA 状态：

```json
{
  "required": true,
  "configured": true,
  "signedIn": false,
  "twoFactorRequired": true,
  "twoFactorConfigured": false,
  "next": "enroll_2fa",
  "migrationProofRequired": false
}
```

字段定义：

- `required`：是否启用整个控制台登录；
- `configured`：密码是否已设置，保留当前兼容语义；
- `signedIn`：当前请求是否携带符合当前认证级别的有效会话；
- `twoFactorRequired`：当前配置是否强制 2FA；
- `twoFactorConfigured`：是否已有确认过的绑定；
- `next`：`setup_password`、`enroll_2fa`、`login` 或 `authenticated`；
- `migrationProofRequired`：旧用户首次绑定是否需要服务器本地迁移码。

该接口及所有认证接口必须返回：

```http
Cache-Control: no-store
Pragma: no-cache
```

### 8.2 `POST /v1/setup`

请求：

```json
{
  "password": "..."
}
```

2FA 关闭时保持兼容：

```json
{
  "ok": true,
  "next": "authenticated"
}
```

并签发 password-only 正式会话。

2FA 开启时：

```json
{
  "ok": true,
  "next": "enroll_2fa"
}
```

服务端必须：

1. 校验和保存密码哈希；
2. 创建短期 enrollment 凭证；
3. 不签发 `umbra_owner`；
4. 设置 `umbra_pre_auth` HttpOnly Cookie；
5. 所有落盘完成后才返回成功。

### 8.3 `POST /v1/login`

2FA 开启且已绑定时，同一次请求提交两个因素：

```json
{
  "password": "...",
  "totp": "123456"
}
```

使用恢复码：

```json
{
  "password": "...",
  "recoveryCode": "ABCD-EFGH-JKLM-NPQR"
}
```

`totp` 和 `recoveryCode` 必须二选一。密码或第二因素错误统一返回：

```http
401 Unauthorized
```

```json
{
  "error": "认证凭证不正确"
}
```

不要向客户端区分“密码错误”或“验证码错误”。

旧版本升级且尚未绑定时，密码及可选迁移码验证成功后只创建 enrollment 凭证：

```json
{
  "ok": true,
  "next": "enroll_2fa"
}
```

### 8.4 `GET /v1/2fa/enrollment`

只允许有效 enrollment 凭证访问。

响应：

```json
{
  "issuer": "Umbra",
  "account": "owner@gate.example.com",
  "secret": "BASE32SECRET",
  "otpauthUri": "otpauth://..."
}
```

如果没有待确认密钥，则生成密钥并先成功落盘，再返回浏览器。进程重启后，管理员重新验证密码和迁移码即可继续绑定同一待确认密钥。

### 8.5 `POST /v1/2fa/enrollment/confirm`

请求：

```json
{
  "code": "123456"
}
```

成功时需要在一个受锁保护的状态变更中完成：

1. 验证 TOTP；
2. 检查 counter 未被使用；
3. 标记绑定为 confirmed；
4. 保存最后使用的 counter；
5. 生成 10 个恢复码并保存哈希；
6. 增加 `auth_epoch`；
7. 撤销全部旧会话；
8. 持久化安全状态；
9. 删除本地迁移码文件；
10. 清除 enrollment Cookie；
11. 签发 MFA 正式会话；
12. 只在本次响应中返回恢复码明文。

响应：

```json
{
  "ok": true,
  "next": "save_recovery_codes",
  "recoveryCodes": [
    "ABCD-EFGH-JKLM-NPQR"
  ]
}
```

持久化失败时不得签发正式会话。

### 8.6 登出接口

`POST /v1/logout` 同时清除：

- `umbra_owner`；
- `umbra_pre_auth`。

`POST /v1/logout-all` 删除全部会话并增加认证代际，确保已经复制的 Cookie 也不能继续使用。

### 8.7 敏感操作与再认证

不单独提供 `/v1/reauth` 短时能力令牌。每个敏感接口在同一次请求中重新提交当前因素，成功后立即生效。

再认证字段约定：

- `password` 或改口令时的 `current`：当前管理员口令；
- `totp` 与 `recoveryCode` 二选一；同时提交返回 `400`；
- 只要已经存在确认过的 TOTP 绑定，**即使当前 `UMBRA_2FA=off`**，改口令仍须第二因素；
- `UMBRA_2FA=off` 时，更换 TOTP 和重生恢复码返回 `403`，提示使用本机 `reset-2fa` 或先开启 2FA。

密码、TOTP 密钥或恢复码集合变化后，必须：增加 `owner_epoch`（仅口令变化）和 `auth_epoch`（口令、绑定、恢复码集合、logout-all、本地重置），撤销其他会话，当前请求只保留新签发的正式会话。

不提供“在线重置/关闭 2FA”接口。

### 8.8 `POST /v1/password`

需要有效正式会话。

无 TOTP 绑定时：

```json
{ "current": "...", "new": "..." }
```

已有绑定时必须带第二因素：

```json
{ "current": "...", "new": "...", "totp": "123456" }
```

或 `{ "current": "...", "new": "...", "recoveryCode": "ABCD-EFGH-JKLM-NPQR" }`。

成功：`{ "ok": true }`，撤销其他会话，给当前浏览器签发新的正式会话（2FA 开启时 `mfa=true`）。

### 8.9 `POST /v1/2fa/replace`

需要 **MFA 正式会话** 且 `UMBRA_2FA=on`。

```json
{ "password": "...", "totp": "123456" }
```

成功后：

1. 生成新的 pending TOTP 密钥，不覆盖已确认密钥；
2. 签发 `purpose=replace` 的 `umbra_pre_auth`；
3. 返回 `{ "ok": true, "next": "enroll_2fa" }`。

随后复用 `GET /v1/2fa/enrollment` 与 `POST /v1/2fa/enrollment/confirm`。确认成功才替换密钥、作废旧恢复码、增加 `two_factor.generation` 与 `auth_epoch`。

### 8.10 `POST /v1/2fa/recovery/regenerate`

需要 MFA 正式会话且 `UMBRA_2FA=on`。

```json
{ "password": "...", "totp": "123456" }
```

成功：作废全部旧恢复码，返回 10 个新明文，增加 `auth_epoch` 并撤销其他会话。

### 8.11 剩余恢复码

`GET /v1/auth` 在已登录且已绑定 2FA 时额外返回 `recoveryRemaining`（整数，含 0）。不返回哈希或已用码。

### 8.12 错误码

| 情况 | HTTP |
| --- | --- |
| 密码或第二因素错误 | `401`，正文 `{ "error": "认证凭证不正确" }` |
| `totp` 与 `recoveryCode` 同时提交、JSON 非法 | `400` |
| 关闭 2FA 时远程改绑定 | `403` |
| 每 IP 或全局限流 | `429` + `Retry-After` |
| 跨站 Origin | `403` |
| 落盘失败 | `500`，不签发会话 |

## 9. 预认证 Cookie

新增短期 enrollment Cookie：

```text
名称：umbra_pre_auth
有效期：5 分钟
HttpOnly：true
SameSite：Strict
Secure：沿用可信 TLS/反向代理判断
Path：/v1
```

登出或确认成功时必须用**完全相同的 Name + Path + Secure + SameSite + HttpOnly** 发 `MaxAge=-1` 覆盖清除。`Path=/v1` 的 Cookie 不能用 `Path=/` 清掉。`POST /v1/logout` 与 `POST /v1/logout-all` 都要清两枚 Cookie。

Cookie 内只放 256 bit 随机 token。服务端只保存 token 哈希：

```go
type pendingAuth struct {
    Purpose           string
    ExpiresAt         time.Time
    Failures          int
    AuthEpoch         int64
    SourceSessionHash string
    FactorGeneration  int64
}
```

要求：

- 存于内存，不写入 `control.json`；
- 最大保留 64 个；
- 超时、成功、登出或失败次数超限后立即删除；
- 绑定 `auth_epoch`、签发时的会话哈希（replace）和 `two_factor.generation`；确认时三者必须仍匹配，且 replace 的原会话仍然有效；
- 修改口令、恢复码登录、重生恢复码、logout-all、本地 reset-2fa 必须清空全部 pending；
- 进程重启后失效，用户重新验证密码即可；
- 只允许访问绑定相关接口，绝不能被 `need` 当作正式会话。

待确认的 TOTP 密钥属于可恢复配置，可持久化；短期 enrollment 凭证不可持久化。

## 10. 正式会话

扩展会话结构：

```go
type ownerSess struct {
    Exp       time.Time
    Last      time.Time
    Issued    time.Time
    AuthEpoch int64
    MFA       bool
}
```

持久化：

```go
type persistSess struct {
    Hash      string `json:"hash"`
    Exp       int64  `json:"exp"`
    Issued    int64  `json:"issued,omitempty"`
    AuthEpoch int64  `json:"auth_epoch"`
    MFA       bool   `json:"mfa"`
}
```

验证规则：

```text
session 未过期
AND now < session.issued + 24h
AND session.auth_epoch == current.auth_epoch
AND (
    !RequireTwoFactor
    OR session.mfa == true
)
```

滑动续期仍为 12 小时，但不得超过 `issued + 24h`。`owner_epoch` 只用于 tomb 防口令回滚；`auth_epoch` 才是会话代际。口令变化时两者都增加。

这样可以保证：

- schema 1 的旧会话没有 MFA 标记，升级后不能使用；
- 2FA 关闭期间签发的 password-only 会话在重新开启后失效；
- 密码、TOTP 或恢复状态变化后，旧代际会话全部失效。

正式 Cookie 保持当前属性：

- `HttpOnly`；
- `SameSite=Lax`；
- HTTPS 时 `Secure`；
- 12 小时有效并维持现有续期策略。

## 11. 持久化 schema 2

将 `persistSchema` 从 1 升为 2，新结构建议如下：

```go
type persistTwoFactor struct {
    Secret        string            `json:"secret,omitempty"`
    Confirmed     bool              `json:"confirmed"`
    LastCounter   int64             `json:"last_counter,omitempty"`
    Generation    int64             `json:"generation"`
    RecoveryCodes []persistRecovery `json:"recovery_codes,omitempty"`
}

type persistRecovery struct {
    Salt string `json:"salt"`
    Hash string `json:"hash"`
}

type persistFile struct {
    OwnerEpoch int64            `json:"owner_epoch,omitempty"`
    AuthEpoch  int64            `json:"auth_epoch,omitempty"`
    TwoFactor  persistTwoFactor `json:"two_factor,omitempty"`
    // existing fields...
}
```

### 11.1 Schema 1 到 2 的迁移

新二进制加载旧状态时：

1. 允许读取 schema 1；
2. 缺失 `TwoFactor` 视为未绑定；
3. 若已有密码且 `UMBRA_2FA=on`，进入 `enrollment_required`；
4. 删除所有旧会话；
5. 增加 `auth_epoch`；
6. 生成本地迁移码；
7. 以 schema 2 原子落盘；
8. 保存成功后才开始提供管理 API；
9. 保存失败时拒绝启动，不能降级到密码单因素。

如果 schema 1 尚未设置密码，则保持 `unconfigured`，首次设置时完成正常 2FA 流程。

### 11.2 降级行为

旧二进制遇到 schema 2 应拒绝启动。这是预期的 fail-closed 行为，避免通过回滚旧版本静默绕过 2FA。

发布说明必须声明这是一次单向认证状态迁移。升级前应备份整个 `tls-dir`，但备份本身包含完整认证凭证，必须安全保存。

### 11.3 Tomb 防回滚

将以下字段加入 `persistTomb`：

- `auth_epoch`；
- TOTP secret；
- confirmed；
- generation；
- last counter；
- 恢复码 salt/hash；
- 本地迁移状态。

从 `.prev` 恢复时，以较新的 tomb 认证状态为准，防止：

- 旧 TOTP 密钥复活；
- 已使用的恢复码重新可用；
- 2FA 重置被回滚；
- 已撤销会话恢复；
- 旧的未绑定状态覆盖新绑定。

恢复码消费等安全状态应先写入 tomb，再写主状态。若 tomb 已成功更新但主状态写入失败，应保守地把该恢复码视为已经消费，返回错误且不签发会话。

## 12. TOTP 密钥存储

TOTP 使用对称密钥，服务端必须取得原始 secret，因此不能像密码一样只保存哈希。

第一版要求：

- 保存在 `/var/lib/umbra/control.json` 和 tomb；
- `tls-dir` 权限保持 `0700`；
- `control.json`、`.prev`、`.tomb` 权限保持 `0600`；
- 不进入 `state.json`、traffic、升级日志或前端持久缓存；
- 备份文档明确说明：泄露 `tls-dir` 备份等价于泄露 TOTP secret。

不要使用同一 `control.json` 中的 `ownerSecret` 加密 TOTP，因为密钥和密文存放在一起不能抵御文件泄露。

如未来需要保护离线备份，可另行增加独立密钥文件，例如：

```text
UMBRA_2FA_KEY_FILE=/run/secrets/umbra-2fa-key
```

第一版不强制该能力，避免额外的不可恢复锁定风险。

## 13. 恢复码

生成 10 个恢复码，每个包含 16 个 RFC 4648 Base32 字符（字母表 `A-Z2-7`，无填充；显示时每 4 个字符插连字符）：

```text
ABCD-EFGH-JKLM-NPQR
```

规则：

- 每个恢复码独立使用 `crypto/rand` 生成；
- 规范化：转大写，去掉空格和连字符，只接受 `A-Z2-7`；
- 每个码 80 bit 随机性；
- 每个码使用独立 16 字节随机 salt，哈希为 `SHA-256(salt || normalized)`；
- 验证时对全部剩余码做恒定时间比较，不因先匹配而提前返回；
- 明文只在生成响应中出现一次；
- 使用后先成功持久化删除，再签发会话；
- 重新生成会立即废止全部旧恢复码；
- 客户端可以查询剩余数量，但服务端不返回任何哈希或已用码信息；
- 恢复码只能与正确密码组合使用，不能单独登录。

建议将生成、规范化和验证逻辑放在 `internal/control/recovery.go`。

## 14. 旧用户迁移码

升级前系统不存在可验证的第二因素。仅验证旧密码后允许绑定，会让已经取得旧密码的远程攻击者有机会抢先绑定自己的设备。

因此旧用户迁移时增加本地一次性证明：

1. 检测到“已有密码、2FA 开启、尚未绑定”；
2. 生成至少 128 bit 随机迁移码；
3. 只在 `control.json`/tomb 保存哈希；
4. 将明文写入 `{tls-dir}/2fa-bootstrap`（即 `filepath.Join(filepath.Dir(control.json), "2fa-bootstrap")`），权限 `0600`。不得写死 `/var/lib/umbra`；
5. 日志只提示文件路径，不能打印明文；
6. 管理员通过 SSH 或 `docker exec` 读取；
7. 首次迁移登录提交原密码和迁移码；
8. 绑定成功后删除该文件并清除迁移码哈希。

迁移码不是日常第三因素，只用于从旧版本建立首次可信绑定。

如果创建迁移码文件或持久化哈希失败，服务必须 fail closed，不能允许仅凭密码完成迁移。

## 15. 丢失设备和本地重置

恢复顺序：

1. 使用密码和任意未消费恢复码登录；
2. 登录后重新验证密码及当前因素，轮换 TOTP；
3. 如果手机和恢复码都丢失，使用服务器本地离线重置。

建议增加：

```bash
sudo systemctl stop umbrad
sudo umbrad -reset-2fa -tls-dir /var/lib/umbra
sudo systemctl start umbrad
```

进程锁：

- 守护进程在启动后对 `{tls-dir}/control.lock` 持有排他锁（Unix `flock`，Windows `LockFileEx`），直到退出；
- 热升级在 spawn 替换进程前释放该锁；
- `-reset-2fa` 以非阻塞方式取同一把锁，失败则退出码非 0，并提示先停止 `umbrad`；
- 该命令本身不监听 HTTP / 控制通道。

离线命令要求：

- 取锁失败视为守护进程仍在运行，拒绝改状态；
- 清除 TOTP secret、confirmed 和恢复码；
- 增加 `auth_epoch` 和 2FA generation；
- 撤销全部会话；
- 保留管理员密码；
- 原子更新 `control.json` 和 tomb；
- 重新生成本地迁移码；
- 重启后强制使用密码和本地迁移码重新绑定；
- 不修改 `UMBRA_2FA`。

不得提供仅凭现有正式 Cookie 即可关闭 2FA 的远程接口。口令、手机、恢复码和 `tls-dir` 备份全部丢失时，只能重装入口；有 `tls-dir` 备份则可恢复后再执行 `-reset-2fa`。

## 16. 暴力破解与限流

当前登录限制只有按 IP 的 8 次/15 分钟。实现 2FA 时改为三层保护。

### 16.1 每 IP

- 15 分钟最多 8 次失败；
- 使用 `requestIP` 和可信代理配置解析客户端地址；
- 不直接使用未经验证的 `X-Forwarded-For`；
- 超限返回 `429 Too Many Requests` 和 `Retry-After`。

### 16.2 单管理员全局退避

因为系统只有一个管理员，增加跨 IP 的全局失败退避：

- allow 在检查通过时立即预占一次尝试，失败不再另加计数；成功则退还该 IP 名额；
- 全进程最多 2 个并行 scrypt；拿不到槽位立即 429；
- 认证 JSON 上限 4KiB；口令/TOTP/恢复码/迁移码有长度上限；
- 改口令、更换 2FA、重生恢复码与登录共用限速器；
- 前 5 次失败正常响应；
- 后续退避 2、4、8、16、32、60 秒；
- 最大 60 秒，避免永久账号锁定；
- 不在请求处理器中 `Sleep`，记录 `notBefore` 并立即返回 429；
- 完整的密码 + 第二因素成功后清零；
- 密码和第二因素失败都计入统一预算；
- 限流状态只在内存，进程重启即清零；持续占满 60 秒退避等于对管理员 DoS，此时可重启进程或走本机 `reset-2fa`，不得因此自动关闭 2FA。

时序与比较：

- 先做每 IP / 全局 `notBefore` 检查，再做 scrypt；
- 无论密码对错，只要已有 TOTP 绑定，都对真实或占位密钥做一次 TOTP HMAC；恢复码路径对占位 salt 做一次 SHA-256；
- TOTP 窗口内三个 counter 都计算并恒定时间比较；
- 认证失败统一 `401` 和同一句错误，不按“密码错 / 验证码错”分支改变耗时路径上的可见工作量。

### 16.3 Enrollment

- 单个 enrollment 凭证最多 5 次 TOTP 失败；
- 超过后销毁凭证，要求重新输入密码及迁移码；
- 有效期 5 分钟。

限流状态可以仅保存在内存中。建议放在独立的 `internal/control/auth_rate.go` 中并使用可注入时钟测试。

## 17. HTTP 与浏览器安全

必须沿用现有 Origin 校验，并应用到全部新增 POST 接口。

新增要求：

- 所有认证响应使用 `Cache-Control: no-store`；
- TOTP secret 和恢复码不进入 URL/query string；
- JSON 请求继续使用现有 body 大小限制和 trailing JSON 检查；
- 使用 `requestIP` 获取可信客户端地址；
- 非回环管理口继续强制 TLS；
- 反向代理只有在来源 IP 命中 `UMBRA_HTTP_TRUST_PROXY` 时才信任转发头；
- 认证失败统一返回通用消息；
- 全部控制台 HTTP 响应增加 `X-Content-Type-Options: nosniff` 和 `Referrer-Policy: no-referrer`。
- 登录必须使用 `requestIP`，不得使用未经验证的 `RemoteAddr` 绕过可信反代解析。

## 18. 前端流程

将 `login-page.tsx` 改为显式 reducer/状态机，不要继续依赖 `configured` 一个布尔值拼接流程。

### 18.1 新安装

```text
设置并确认密码
→ 显示二维码和手工密钥
→ 输入六位验证码
→ 展示并允许复制/下载恢复码
→ 勾选“我已安全保存恢复码”
→ 进入控制台
```

### 18.2 旧版本升级

```text
输入原密码
→ 输入服务器本地迁移码
→ 显示二维码和手工密钥
→ 输入六位验证码
→ 保存恢复码
→ 进入控制台
```

### 18.3 日常登录

同一个表单包含：

- 密码；
- 六位验证码；
- “改用恢复码”切换。

前端约束：

- OTP 使用 `inputMode="numeric"`；
- OTP 使用 `autoComplete="one-time-code"`；
- 密码使用 `autoComplete="current-password"`；
- 密码、TOTP、恢复码不能进入 URL、React Query cache、localStorage 或 sessionStorage；
- QR 在浏览器本地根据 `otpauthUri` 渲染，避免可缓存的服务端图片接口；
- 绑定页必须同时显示可复制的手工密钥；
- 页面刷新后可通过新的 enrollment 请求恢复流程；
- 成功后统一 invalidate `['umbra', 'owner']`；
- 错误提示不得回显任何凭证；
- 恢复码返回后必须允许一次性下载文本文件；
- 用户关闭页面导致未保存恢复码时，仍可用 TOTP 登录后重新生成，但需要再次验证密码和 TOTP。

## 19. 审计与日志

建议增加以下事件：

```text
auth.login.success
auth.login.failure
auth.login.rate_limited
auth.2fa.enrollment_started
auth.2fa.enrolled
auth.2fa.replaced
auth.2fa.recovery_used
auth.2fa.recovery_regenerated
auth.2fa.local_reset
auth.2fa.disabled_by_config
```

规则：

- 永远不记录密码、TOTP、恢复码、TOTP secret、二维码 URI或迁移码；
- 登录失败不能无限写入当前最多 200 条的业务审计数组，否则可被用来冲掉重要事件；
- 高频成功、失败、限流写结构化运行日志；
- 绑定、重置、恢复码使用等低频安全事件写持久审计；
- 记录规范化 IP 和必要的 User-Agent 摘要，不保存完整请求头；
- 为新审计动作补充中文显示标签。

## 20. 并发与持久化不变量

开发时必须显式覆盖以下并发场景：

1. 两个请求同时使用同一个 TOTP，最多一个成功；
2. 两个请求同时消费同一个恢复码，最多一个成功；
3. 两个首次设置请求同时提交，只有一个能取得管理员所有权；
4. 绑定确认与本地 reset-2fa 并发时不得产生混合状态；
5. 密码变更、TOTP 轮换和 logout-all 不得复活旧会话；
6. `save()` 失败后内存状态、tomb 和主状态必须遵循 fail-closed 语义；
7. 正式会话只能在安全状态已经成功持久化后创建并返回。

TOTP counter 验证、更新、会话创建和状态保存需要在同一控制台锁保护的提交路径中完成。耗时的密码哈希可以在锁外计算，但提交前必须重新检查相关认证代际和状态没有变化。

## 21. 测试计划

### 21.1 TOTP 单元测试

- RFC 6238 官方测试向量；
- Base32 大小写和无填充解析；
- 当前、前一、后一时间片；
- 超出窗口拒绝；
- 非六位输入拒绝；
- 同一 counter 重放拒绝；
- 并发使用同一验证码只有一个成功；
- 可注入时间下的边界测试。

### 21.2 恢复码测试

- 数量、格式和随机性来源；
- 大小写、空格、连字符规范化；
- 错误码拒绝；
- 正确码只使用一次；
- 并发消费只有一个成功；
- 落盘失败不签发会话；
- `.prev` 恢复不能复活已用恢复码。

### 21.3 HTTP 集成测试

- 新安装在绑定完成前无法访问 `/v1/overview`；
- 只验证密码不产生 `umbra_owner`；
- enrollment Cookie 不能访问受保护 API；
- 错误 TOTP 不产生正式会话；
- 正常 TOTP 登录；
- 密码 + 恢复码登录；
- `totp` 与 `recoveryCode` 同时提交时拒绝；
- 认证接口跨站 Origin 被拒绝；
- 限流使用可信代理 IP；
- 认证响应带 `no-store`；
- logout 清理正式和预认证 Cookie；
- 2FA 关闭时维持密码登录兼容；
- 重新开启后拒绝 password-only 会话；
- 敏感操作要求再认证。

### 21.4 升级和持久化测试

- schema 1 有密码、无会话；
- schema 1 有密码、有活跃会话；
- schema 1 未设置密码；
- schema 1 升级时生成本地迁移码；
- 迁移码错误、已用、缺失时拒绝；
- schema 2 被旧程序读取时拒绝启动；
- 当前文件损坏时从 `.prev` 恢复，并以 tomb 最新 2FA 状态为准；
- 已使用恢复码不因 `.prev` 恢复而复活；
- TOTP 重置不因 `.prev` 恢复而回滚；
- 热升级后数据面恢复，但旧管理会话失效；
- 状态目录只读、磁盘满、原子 rename 失败时 fail closed；
- 本地 reset-2fa 保留密码并撤销所有会话。

### 21.5 前端测试

- 新安装完整流程；
- 升级绑定流程；
- 日常 TOTP 登录；
- 恢复码切换；
- 绑定页刷新；
- 请求失败和超时；
- 重放验证码提示；
- 限流及 `Retry-After` 提示；
- 键盘操作、焦点顺序和屏幕阅读器标签；
- 恢复码复制和下载；
- 任何凭证都不进入浏览器持久存储。

## 22. 建议实施顺序

### 阶段 1：后端状态和迁移

- 环境变量解析；
- schema 2；
- tomb 防回滚字段；
- 会话 `MFA` 与 `AuthEpoch`；
- schema 1 迁移及旧会话失效。

### 阶段 2：认证原语

- TOTP 生成与验证；
- counter 重放保护；
- 恢复码；
- enrollment 凭证；
- 全局和每 IP 限流。

### 阶段 3：HTTP 流程

- 扩展 `/v1/auth`；
- 修改 `/v1/setup` 和 `/v1/login`；
- enrollment 获取与确认接口；
- logout、logout-all 和密码修改；
- no-store、错误码及审计。

### 阶段 4：恢复和迁移保护

- 本地迁移码；
- 离线 reset-2fa；
- 容器及 systemd 操作文档。

### 阶段 5：前端

- 登录页状态机；
- QR 和手工密钥；
- 恢复码保存页；
- 日常 TOTP/恢复码登录；
- 错误、重试、无障碍体验。

### 阶段 6：回归与文档

- Go 单元和集成测试；
- TypeScript 类型检查及前端测试；
- 热升级测试；
- README、Compose、CHANGELOG 和升级提示。

每个阶段完成后运行仓库现有检查，最终至少执行：

```bash
go test ./...
npm test
npm run typecheck
npm run lint
npm run build:embed-ui
```

如果仓库现有命令或构建流程有变化，应使用当前真实命令，并在开发总结中说明。

## 23. 验收标准

功能只有在以下条件全部满足时才算完成：

- [ ] 未配置环境变量时 2FA 默认开启；
- [ ] `UMBRA_2FA=off` 可以明确关闭，非法值拒绝启动；
- [ ] 新安装绑定完成前无法获得正式会话；
- [ ] 旧用户升级后原会话立即失效；
- [ ] 旧用户必须完成强制绑定；
- [ ] 日常登录必须验证密码和 TOTP/恢复码；
- [ ] password-only 会话不能在重新开启 2FA 后使用；
- [ ] TOTP counter 不可重放；
- [ ] 恢复码一次性、只存哈希、只展示一次；
- [ ] 密码或 2FA 变化会撤销旧会话；
- [ ] `.prev` 恢复不能回滚 2FA 安全状态；
- [ ] 所有敏感认证状态落盘失败时 fail closed；
- [ ] 任何日志和审计都不含认证秘密；
- [ ] 每 IP 和管理员全局限流均已实现；
- [ ] 本地迁移码能够防止远程抢绑；
- [ ] 离线 reset-2fa 恢复路径经过自动化测试；
- [ ] README 和部署文件说明默认开启、升级影响和恢复方式；
- [ ] `go test ./...`、前端测试、类型检查和构建通过；
- [ ] 现有 Node、Mapping、Visitor、SPA、数据面和热升级功能无回归。

## 24. 安全边界说明

该功能主要抵御：

- 管理员密码泄露；
- 密码复用和撞库；
- 普通在线暴力破解；
- 仅取得旧管理密码的远程攻击者。

该功能不承诺抵御：

- 实时反向代理钓鱼；
- 管理员终端恶意软件；
- 已被盗的有效 MFA 会话 Cookie；
- 服务器 root 权限或 Docker 管理权限失陷；
- 包含 `control.json` 的备份泄露；
- 有权修改 `UMBRA_2FA`、`UMBRA_LOGIN`、`GROK_AGENT` 或 `GROK_PROJECT_ID` 的运维人员；
- 关闭 2FA 期间的单因素登录（这是明确的降级，不是漏洞）；关闭期间远程改绑定被禁止，因此该窗口不能用来抢绑。

生产环境仍必须使用 HTTPS 或默认的 loopback + SSH 隧道，保护服务器文件权限，并安全保存恢复码和 `tls-dir` 备份。预览环境的 `GROK_AGENT` / `GROK_PROJECT_ID` 不得出现在生产 `umbrad` 进程中。

## 25. 参考标准

- RFC 6238, TOTP: Time-Based One-Time Password Algorithm: <https://www.rfc-editor.org/info/rfc6238/>
- RFC 4226, HOTP: An HMAC-Based One-Time Password Algorithm: <https://www.rfc-editor.org/rfc/rfc4226>
- NIST SP 800-63B, Authentication and Authenticator Management: <https://pages.nist.gov/800-63-4/sp800-63b.html>

## 26. 代际、锁与绑定窗口（规范）

### 26.1 `owner_epoch` 与 `auth_epoch`

| 计数器 | 作用 | 增加时机 |
| --- | --- | --- |
| `owner_epoch` | tomb 防口令回滚 | 首次设置口令、修改口令 |
| `auth_epoch` | 会话是否有效 | schema 1→2 迁移、口令变化、TOTP 确认/更换、恢复码重生、使用恢复码登录、logout-all、本地 reset-2fa |

会话只比较 `auth_epoch`。tomb 同时保存两者以及完整 2FA 状态。从 `.prev` 恢复时仍以 tomb 中较新的认证状态为准。

使用恢复码登录视为可能的失窃响应：消费该码、增加 `auth_epoch`、撤销其他会话，再签发新的 MFA 会话。

### 26.2 关闭 2FA 时允许与禁止

允许：

- 用已有绑定做日常口令+TOTP/恢复码登录（若客户端仍提交第二因素，应接受，不得改成只验口令之外的第二种成功路径）；关闭期间日常登录只验口令，签发 `mfa=false` 会话；
- 已有绑定的改口令（须第二因素）；
- 本机 `reset-2fa`。

禁止：

- `POST /v1/2fa/replace`
- `POST /v1/2fa/recovery/regenerate`
- 任何远程解绑或覆盖已确认 TOTP 的接口

重新开启 2FA 后：`mfa=false` 的会话立即无效；继续使用原绑定。

### 26.3 Enrollment 二维码

`GET /v1/2fa/enrollment` 在 JSON 中返回 `otpauthUri`、手工 `secret`，以及 `qrPng`（PNG 的标准 Base64，不含 `data:` 前缀）。这不是可缓存的独立图片 URL。响应必须 `Cache-Control: no-store`。前端用 `data:image/png;base64,` 拼接展示，并同时显示可复制手工密钥。

### 26.4 验收补充

- [ ] `GROK_AGENT` / `GROK_PROJECT_ID` / `UMBRA_LOGIN=off` 跳过认证时启动有警告，且忽略 `UMBRA_2FA`；
- [ ] 关闭 2FA 期间 replace / regenerate 返回 403，改口令在已绑定情况下仍要第二因素；
- [ ] 登出能清掉 `Path=/v1` 的 `umbra_pre_auth`；
- [ ] 迁移码写在 `{tls-dir}/2fa-bootstrap`；
- [ ] `-reset-2fa` 在守护进程持锁时失败；
- [ ] TOTP 与恢复码使用恒定时间比较；
- [ ] 会话不超过签发后 24 小时。
