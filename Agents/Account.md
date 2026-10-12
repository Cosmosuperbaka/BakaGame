# 账号

涉及登录、账号资料、头像、账号 HTTP API（oRPC）或管理员身份时查阅。存储层见 [Database](Database.md)。

## 1. 身份与边界

- 账号以 **QQ 号**为身份锚点：登录邮箱只接受 `QQ号@qq.com`，`qqNumber` 由 Better Auth 建号钩子从邮箱派生，客户端无法自报。
- 只有邮箱验证码一种登录方式（6 位、5 分钟有效、每枚最多试 3 次、库内只存摘要）。首次登录即注册，必须填写账号昵称。
- 账号昵称与游戏内昵称互不捆绑；账号昵称由用户填写（QQ 昵称接口需 QQ 登录态，不可用）。
- 游客游玩不受影响：账号系统随 `DATABASE_URL` 启用，未启用时 `/api/auth/*`、`/api/rpc/*`、`/api/account/avatar/*` 统一回 503 `ACCOUNT_DISABLED`，前端据此隐藏登录入口。
- 代码入口：`infrastructure/auth/Auth.ts`（Better Auth 配置）、`application/AccountService.ts`（发码、资料、头像）、`transport/routes/Account.ts`（HTTP 入口）、`shared/Account.ts` 与 `shared/ApiContract.ts`（前后端共享常量与契约）。

## 2. HTTP 面

| 前缀 | 内容 | 规则 |
|---|---|---|
| `/api/auth/*` | Better Auth | 只开放 `sign-in/email-otp`、`get-session`、`sign-out`，其余端点（含自带发码、注册、改资料、admin）一律 404 |
| `/api/rpc/*` | oRPC（`apiContract`） | 契约在 `shared/ApiContract.ts`；客户端只取类型，运行时不打包 zod 契约 |
| `/api/account/avatar/:userId` | 头像代理 | `?v=` 等于当前摘要时 `immutable` 一年，否则 5 分钟；`size=100` 或 `640` |

- 发码走 oRPC `account.requestLoginCode`：Better Auth 自带发码端点把投递异常吞进后台日志，用户会白等，因此不开放。投递失败返回 503 `MAIL_UNAVAILABLE`。
- `sign-in/email-otp` 的前置钩子在**消耗验证码之前**校验 QQ 邮箱、拒绝客户端自带 `image`、要求新号带昵称，避免用户白白作废一枚验证码。
- 业务错误码到 HTTP 状态的映射只有一份：`statusOfAppError`（HTTP 全局错误钩子与 oRPC 共用）。oRPC 错误的 `code` 即 `AppError.code`，`message` 可直接展示。

## 3. 限流

- Better Auth 自带的按 IP 限流与 IP 记录关闭：经反向代理时全体客户端共享代理 peer，按 IP 限流会误伤全站（同 [Deployment](Deployment.md#反向代理职责) 的口径）。
- 发码按邮箱冷却 60 秒、每小时 6 次，全站每分钟 30 次保护 SMTP 额度；冷却秒数与前端倒计时共用 `LOGIN_CODE_RESEND_SECONDS`。
- 验证码暴力尝试由「每枚 3 次 + 发码配额」共同约束。

## 4. 头像与隐私

- QQ 号默认不公开（`showQq=false`），只有本人开启后，资料卡（`account.publicProfile`）才返回 QQ 号。
- 浏览器只拿站内代理地址 `/api/account/avatar/<userId>?v=<摘要>`；qlogo 的 `nk=QQ号` 不出现在任何他人可见的响应里。注册确认页直接展示 qlogo 是例外：那时 QQ 号就是用户自己刚输入的。
- 刷新时机：前端每次访问调用一次 `account.me`，服务端距上次回源不足 10 分钟则跳过；字节摘要变化才改 `image`（URL 换版本）。回源失败保留旧头像，只记告警。
- 头像字节只缓存在进程内存（总量 32 MB、6 小时），不落库。

## 5. 游戏内身份

- WebSocket 握手（三款游戏同一入口）带 Cookie 时解析会话，结果写入 `ConnectionRecord.account`（`PlayerAccount`：`userId` + 站内头像地址）。头像按 ID 读库，不用最长 5 分钟的会话 Cookie 缓存。
- 账号系统故障或会话无效时以游客身份进入，绝不拦截游戏握手。
- 玩家接管座位（加入、重连、顶号）时 `player.account` 取当前连接的账号，三款游戏的玩家视图原样透出。登录或退出后前端须重连 WebSocket 才会刷新身份。
- 房间快照只带 `userId` 与头像地址，不带账号昵称与 QQ 号；资料卡由前端按 `userId` 调 `account.publicProfile`。每名登录玩家约增加 80 字节全量快照，差量只在变化时发送。

## 6. 管理员

- `ADMIN_QQ`（逗号分隔）中的 QQ 号建号时即为 `admin`，启动时把已注册的同名单账号提升为 `admin`。只提升不降级：后续角色变更在管理后台完成。

## 7. 配置

| 变量 | 说明 |
|---|---|
| `BETTER_AUTH_SECRET` | 配置 `DATABASE_URL` 时必填，至少 32 字符随机串（`openssl rand -hex 32`） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | 三项（除端口）须成套；端口缺省 465（隐式 TLS），其余端口强制 STARTTLS。生产必填 |
| `MAIL_FROM` | 发件人，缺省为 `SMTP_USER` |
| `MAIL_DEV_CONSOLE` | 仅非生产：`true` 时验证码写入服务日志，便于本地联调；生产启用即拒绝启动 |
| `ADMIN_QQ` | 管理员 QQ 号名单 |

会话 Cookie 前缀 `bakagame`，有效期 30 天、每日续期；生产强制 `Secure`。来源判定与 WebSocket 共用 `isAllowedOrigin`。

## 8. 测试

- `test/Account.test.ts` 以 Better Auth 内存适配器 + 捕获邮件 + 假 qlogo 覆盖：发码与登录、昵称校验、白名单、限流、投递失败、管理员引导、隐私与头像缓存。不连真实数据库与 qlogo。
- 对真实 TiDB 与 SMTP 的验证属于一次性人工验收，结束后删除测试账号。
