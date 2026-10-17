# 账号

涉及登录、账号资料、头像、账号 HTTP API（oRPC）、云同步设置、站内反馈或管理员身份时查阅。存储层见 [Database](Database.md)。

| 工作范围 | 查阅章节 |
|---|---|
| 登录方式、身份锚点、停用边界 | §1、§2 |
| 发码限流与验证码 | §3 |
| 头像、QQ 号隐私、昵称查询 | §4 |
| 游戏内身份与重连刷新 | §5 |
| 云同步设置 | §6 |
| 站内反馈 | §7 |
| 管理后台、审计与访问统计 | §8 |
| 环境变量与会话 Cookie | §9 |
| 验收要点 | §10 |

## 1. 身份与边界

- 账号以 **QQ 号**为身份锚点：登录邮箱只接受 `QQ号@qq.com`，`qqNumber` 由 Better Auth 建号钩子从邮箱派生，客户端无法自报。
- 只有邮箱验证码一种登录方式（6 位、5 分钟有效、每枚最多试 3 次、库内只存摘要）。首次登录即注册；账号昵称强制使用 QQ 昵称，昵称查询不可用时停用新号注册（见 §4）。
- 账号昵称与游戏内昵称互不捆绑；账号昵称即 QQ 昵称，注册后不可修改（见 §4）。
- 游客游玩不受影响：账号系统随 `DATABASE_URL` 启用，未启用时 `/api/auth/*`、`/api/rpc/*`、`/api/account/avatar/*` 统一回 503 `ACCOUNT_DISABLED`（RPC 前缀按 oRPC 错误编码，客户端从 `ORPCError.code` 识别），前端据此隐藏登录入口。
- 代码入口：`infrastructure/auth/Auth.ts`（Better Auth 配置）、`application/AccountService.ts`（发码、资料、头像）、`transport/routes/Account.ts`（HTTP 入口）、`shared/Account.ts` 与 `shared/ApiContract.ts`（前后端共享常量与契约）。
- 前端入口：`lib/Api.ts`（oRPC 客户端、Better Auth 登录与错误文案）、`stores/UseAccountStore.ts`（`loading` / `unavailable` / `guest` / `signedIn`）、`hooks/UseAccountBootstrap.ts`（根布局里载入账号、登录期间运行云同步、上报访问）、`components/account/`（登录、资料、反馈弹窗与主页入口）。账号接口失败（`ACCOUNT_DISABLED` 以外）按游客处理并记告警，绝不挡住游玩。
- 前端只展示中文错误文案：oRPC 错误取 `message`（校验失败取首条中文问题），Better Auth 的英文错误码在 `AUTH_MESSAGES` 映射成中文，其余退回兜底文案。

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

### QQ 昵称（NapCat）

- 昵称来源是管理员自建的 **NapCatQQ 实例**（NTQQ 协议 + OneBot 11 HTTP）：站点调 `get_stranger_info` 取 `nickname`，与手机 QQ 资料卡一致。不再走 QQ 空间网页登录——那条链路（ptlogin 扫码 + `cgi_get_portrait.fcg`）会被 QQ 侧按 UA 吊销登录态（实测两次会话分别约 4h / 89min），已整体删除（`infrastructure/auth/QQNapCatClient.ts`、`application/QQNicknameService.ts`）。
- 站点不再持有 QQ 登录态：`qq.lookupSession`、扫码接口与 `qq.login` / `qq.logout` 审计动作全部移除，登录与掉线由 NapCat 一侧负责；`site_config` 表随之失去读写方（见 [Database](Database.md)）。
- 连接方式：`QQ_NAPCAT_API_URL`（OneBot HTTP 基址）与 `QQ_NAPCAT_ACCESS_TOKEN`（Bearer 令牌）成对配置，缺一即启动失败。生产走内网直连、不经过边缘与公网：NapCat 侧 nginx 只放行 `/onebot-internal/` 一个 location，来源限定 BakaGame 宿主内网 IP；BakaGame 容器用 `extra_hosts` 把域名指到 NapCat 内网地址。
- **账号昵称强制使用 QQ 昵称**：新号发码前必须取到昵称（限时 3 秒），取不到即拒绝发码——NapCat 未配置、掉线、令牌错误或该号查不到昵称时停用新号注册；老号登录不查询、不受影响。建号钩子经 `resolveNickname` 再解析一次（优先命中发码时的查询缓存，进程重启等缓存丢失时补一次实时查询），仍取不到则拒绝建号。`requestLoginCode` 返回的 `qqName` 即新号注册后将使用的账号昵称，注册页只读展示。
- 昵称跟随：每次 `account.me` 距上次检查满 24 小时才后台刷新，刷新到新昵称即同步账号昵称与 `user.qq_name`，查不到时保留旧值。`user.qq_name` 存最近一次查到的 QQ 昵称，只出现在后台用户列表，资料卡与房间快照都不带。
- 请求节流与清洗：单批并发 4、相邻两次 OneBot 调用间隔 60ms（约 16 QPS）；昵称经 shared 的 `normalizeAccountName` 清洗（QQ 昵称常带方向隔离符 `U+2066`/`U+2067` 等不可见字符）。后台「刷新全部」单次最多 200 个、同一时刻只跑一轮，一次没查成即整批不动、不把账号标成已查。掉线不做持久标记：NapCat 侧多为临时状态，恢复后下一次请求即可用。
- 后台接口 `admin.qq.*`：`status`（实时探测 NapCat 登录号——它只是本地的 `get_login_info`，不碰 QQ 侧接口，因此不缓存，保证「重新检测」点下去立刻反映真实状态）、`refreshNames`（按 §8 先写审计 `qq.refreshNames`）。

## 5. 游戏内身份

- WebSocket 握手（三款游戏同一入口）带 Cookie 时解析会话，结果写入 `ConnectionRecord.account`（`PlayerAccount`：`userId` + 站内头像地址）。头像按 ID 读库，不用最长 5 分钟的会话 Cookie 缓存。
- 账号系统故障或会话无效时以游客身份进入，绝不拦截游戏握手。
- 玩家接管座位（加入、重连、顶号）时 `player.account` 取当前连接的账号，三款游戏的玩家视图原样透出。登录或退出后前端须重连 WebSocket 才会刷新身份：`refreshSocketIdentities()` 关闭现有连接，交给各游戏既有的断线重连与回房逻辑，新握手带上新 Cookie。
- 房间快照只带 `userId` 与头像地址，不带账号昵称与 QQ 号；资料卡由前端按 `userId` 调 `account.publicProfile`。每名登录玩家约增加 80 字节全量快照，差量只在变化时发送。
- 前端：三款游戏共用的 `PlayerRow` 收 `player.account`，登录玩家显示账号头像（加载失败退回首字），整行可点，浮层顶部是资料卡（`ProfileCard`），房主操作排在其下。资料按用户在同一访问内只取一次（`lib/ProfileCache`），失败不缓存、卡内可重试；本人改资料后作废自己那一条。

## 6. 云同步设置

- `user_setting` 一行一个键，整体覆盖，不做字段级合并：`preferences` 是前端自定的轻量偏好文档（音量、房间设置记忆等，序列化后 ≤ 32 KB，`PREFERENCES_MAX_BYTES`），服务端不解释其中字段。
- 猜歌音乐账号按平台分键 `music.netease` / `music.qq`，内容含平台 cookie，由 `SettingCipher` 以 AES-256-GCM 加密后落库：密钥自 `BETTER_AUTH_SECRET` 经 HKDF 派生，附加数据绑定「用户 ID + 键」。密文挪行、篡改或密钥轮换后一律视为云端无数据并记告警，用户重新登录音乐账号即覆盖。
- 只有本人能读写自己的设置（`settings.*` 全部要求登录）；`saveMusicSession` 传 `session: null` 表示退出该平台并删除云端副本。
- 前端（`lib/CloudSync.ts`）只同步本地存储里的游戏昵称、猜歌音量与房间设置记忆（建房与房间设置两类前缀），不含房间恢复、访客 ID 等本机状态；值按原字符串放进 `preferences`。本地写入经 `PREFERENCES_CHANGED` 通知、防抖 2 秒整体上传，与上次上传相同或超出上限时跳过；写回本地后发 `PREFERENCES_APPLIED`，已挂载的组件（音量）据此重读。
- 冲突口径：登录时偏好逐键合并、同键以云端为准，合并结果与云端不同才回传，两边都没有时不建文档；音乐账号按平台，云端有则写回本地（不回传），只有本地有则上传。之后本地登录或退出音乐账号即上传或删除云端副本。读取云端失败时本次访问不同步。

## 7. 站内反馈

- 只有登录用户能提交（`feedback.create`），每人每小时 5 条；标题 ≤ 60、正文 ≤ 2000 字符。
- 落库后同步为 Sentry User Feedback（`captureServerFeedback`），只带账号 ID 与昵称，不带邮箱与 QQ 号；Sentry 未启用或投递失败不影响站内反馈，`sentryEventId` 留空。
- 未读口径：`lastReplyAt` 晚于 `userSeenAt`。`feedback.get` 读取本人反馈详情并标记已读；他人的反馈一律 404。

## 8. 管理员

- `ADMIN_QQ`（逗号分隔）中的 QQ 号建号时即为 `admin`，启动时把已注册的同名单账号提升为 `admin`。只提升不降级：后续角色变更在管理后台完成。
- 管理接口挂在 oRPC `admin.*`（`application/AdminService.ts`），覆盖用户（查询、封禁、解封、角色、强制下线）、反馈（列表、详情、回复、状态）、对局记录与审计查询。每次调用按 ID 读库校验 `role=admin` 且未封禁；会话读取一律跳过 Cookie 缓存，降级、封禁与强制下线立即生效。
- 不能对自己封禁或改角色，不能封禁管理员（先降级）；被封用户须先解封才能提为管理员。封禁同时删除其全部会话；封禁中的账号发码直接回 403 `ACCOUNT_BANNED`，不消耗发信额度，限时封禁到期后由 Better Auth 在登录时自动解除。
- 每个写操作**先写审计再执行**（`audit_log`）：审计写入失败则操作不做。审计不记 IP，理由同 §3。
- 前端后台页 `/admin`（`pages/AdminPage.tsx` 与 `components/admin/`）覆盖以上全部接口，布局见 [Design §7.4](Design.md#74-管理后台)。
- 管理员回复反馈后，用户侧出现未读；状态为 `open` 的反馈被回复时自动转为 `processing`。
- 实时房间经 `admin.rooms.*` 列出、关闭与移人。三款游戏各自实现 `domain/AdminRoom.ts` 的 `AdminRoomControl`，后台不直接改房间状态：关房复用各游戏的关房通知（谁是卧底、猜歌原因码 `admin_closed`，CEE 直接给文案），移人复用房主踢人的结算口径，且允许移走房主（按各游戏规则重选）。CEE 只管增强房，原版房在上游服务器。房间视图不含会话令牌与对局秘密；测试房、猜歌单人房带 `hidden` 照常列出。
- 概览 `admin.stats.overview`：账号数、反馈积压、三款游戏实时房间与在线人数，以及按北京时间自然日（1–90 天，不缺日）的访客、浏览、新注册与对局数。对局数按「一局 = 一个房间的生命周期」计数，记录永久保留，见 [GameRecord](GameRecord.md)。
- `admin.stats.sentry` 由服务端以 `SENTRY_API_TOKEN` 代查 Sentry（`infrastructure/SentryApi.ts`）：组织与区域从 `SENTRY_DSN` 读出，项目取隧道白名单（前后端两个项目）；近 24 小时错误数、未解决问题前 5、调用最多的事务 p75/p95。三个查询各自容错，结果缓存 60 秒；令牌只在服务端，返回与日志都不含令牌。

### 访问统计

- 前端每进入一个新板块调用一次公开接口 `site.visit`（`lib/VisitReport.ts`，`visitorId` 为浏览器本地随机值），同板块内换房不重复上报；账号系统未启用时接口 503，前端静默忽略。
- `SiteStatsService` 在进程内聚合、每分钟刷写 `site_visit_daily` / `site_page_daily`，关闭时先刷写再关数据库；写库失败丢弃该窗口。
- 访客 ID 落库前与「HKDF 派生密钥 + 北京时间当天」做 HMAC：跨天不可关联、库内还原不出原 ID。不记录 IP；已登录访客关联账号 ID。
- 页面只按板块统计（`/whoisfaker`、`/songuessr/room`、`/admin` 等），房号折叠、未知路径记为 `other`，统计表不会按房号膨胀。
- 单窗口最多跟踪 5000 个新访客，超出只计页面浏览，保护进程内存；访客行保留 90 天，页面汇总不含个人数据、长期保留。

## 9. 配置

| 变量 | 说明 |
|---|---|
| `BETTER_AUTH_SECRET` | 配置 `DATABASE_URL` 时必填，至少 32 字符随机串（`openssl rand -hex 32`） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | 三项（除端口）须成套；端口缺省 465（隐式 TLS），其余端口强制 STARTTLS。生产必填 |
| `MAIL_FROM` | 发件人，缺省为 `SMTP_USER` |
| `MAIL_DEV_CONSOLE` | 仅非生产：`true` 时验证码写入服务日志，便于本地联调；生产启用即拒绝启动 |
| `ADMIN_QQ` | 管理员 QQ 号名单 |
| `SENTRY_API_TOKEN` | 选填：后台概览代查 Sentry 的只读令牌（`org:read`、`project:read`、`event:read`）；须同时配置 `SENTRY_DSN`，只支持 sentry.io 的 DSN |
| `QQ_NAPCAT_API_URL` / `QQ_NAPCAT_ACCESS_TOKEN` | QQ 昵称来源（NapCat 的 OneBot 11 HTTP 基址 + Bearer 令牌）；**成对配置**，两者都不配时昵称查询整体停用（新号注册随之停用） |

会话 Cookie 前缀 `bakagame`，有效期 30 天、每日续期；生产强制 `Secure`。来源判定与 WebSocket 共用 `isAllowedOrigin`。

## 10. 验收要点

命令与验证范围见 [Testing](Testing.md#验证范围)；本节只列必须覆盖的行为。

- 账号：验证码发码与登录、注册昵称强制取自 QQ 昵称、端点白名单、发码限流、投递失败、管理员引导、QQ 号隐私与头像缓存。使用内存适配器与假上游，不连真实数据库与 qlogo。
- 设置与反馈：整体覆盖写、加密与越权、反馈的 Sentry 同步、限流与未读口径。
- 管理：权限分层、降级即时生效、搜索、封禁（踢线、拦发码、到期恢复）、自我与管理员保护、审计先行（可注入一次写入失败）、反馈回复、对局记录查询与实时房间的审计委托。
- 访问统计：路径折叠、访客摘要跨天不可关联、写库失败丢弃、过期清理、上报接口、概览补零，以及 Sentry 客户端对容错、参数、缓存与令牌不外泄的处理。
- 昵称查询：以假 NapCat（OneBot 11）覆盖 Bearer 鉴权、单号查询与查不到跳过、全部失败即判不可用、不可见字符清洗、掉线降级与停用注册、访问刷新与昵称同步、批量刷新审计；真实实例只能人工验收。
- 前端：接口错误文案、云同步范围与合并、访问上报、登录弹窗的 QQ 昵称冻结与就地报错、资料卡缓存与重试、后台页的权限分层与关房确认。
- 真实 TiDB 与 SMTP 的一次性人工验收结束后删除测试账号。
