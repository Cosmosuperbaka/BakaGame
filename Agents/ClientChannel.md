# 客户端通道证明协议（BakaAntiCheat 的地基）

> 本文是「壳 ↔ 服务端」契约的唯一真相源。桌面壳（`Desktop/`）、移动壳（`Mobile/`）、
> 服务端（`Server/src/infrastructure/ClientChannel.ts`）与前端探测（`Client/src/lib/BakaChannel.ts`）
> 必须逐字对齐这里的字段名与判定口径；任何一方改了字段，本文件必须先改。

## 1. 它证明什么、不证明什么

证明的是**「这次连接来自我们的壳，而且是这台设备上那个已注册的密钥在签名」**，
不是「这台机器干净」。强度分级见 §5。

- 不追求防住逆向：私钥在用户自己的机器上，肯逆向就能提取。它的目标是让自写客户端
  必须先做一次逆向，而不是直接 `new WebSocket()`。
- 强度只影响**反作弊房**（`bakaAntiCheat`）的准入。普通房完全不读这些字段，Web 玩家照常游玩。

## 2. 三次往返

```
首次运行  壳生成密钥对 → POST /api/client/register  →  服务端按公钥派生 clientId
每次连接  POST /api/client/challenge → 拿 challenge
         壳用私钥签 challenge      → POST /api/client/attest → 拿 ticket
         页面开 ws 时带 ticket     →  服务端验票并写 connection.clientChannel
```

`clientId` 由公钥派生（`sha256(publicKey)` 前 24 位），所以**注册天然幂等**：同一把密钥
重复注册得到同一个 `clientId`，不需要「证明我拥有这把密钥」这种额外往返——拥有关系在
每次 `attest` 里都在证。

`ticket` 是一次性的：30 秒 TTL、**换票成功即焚**、绑定签发时的来源地址与 `clientId`。
所以「把 ticket 发给别人」在另一台机器上用不掉。地址不符只拒不用：代理链与 `requestIP`
的口径可能不一致，此时销毁 ticket 会让合法客户端永远连不上，而它本来也没换成任何凭据。

## 3. 字段表（逐字）

### `POST /api/client/register`

| 字段 | 必填 | 说明 |
|---|---|---|
| `clientType` | 是 | `"desktop"` \| `"mobile"` |
| `platform` | 是 | `"windows"` \| `"android"`（只入库供排查，不参与判定） |
| `clientVersion` | 是 | 语义化版本 `x.y.z` |
| `keyAlgorithm` | 是 | `"ed25519"`（桌面）\| `"ec-p256"`（Android KeyStore） |
| `publicKey` | 是 | base64。ed25519 = 32 字节裸公钥；ec-p256 = **SPKI DER** |
| `keyProtection` | 桌面 | `"hardware"` \| `"software"`，DPAPI 是否可用 |
| `selfCheck` | 是 | 见下 |
| `attestation` | 移动 | `{ attestationChallenge, chain }`，`chain` 是 PEM 数组（叶子在前）；服务端验链并把结论档位记进设备表 |

`selfCheck` 形状：`{ hardFail: string[], softFail: string[], keyProtection?, attestationLevel? }`
`attestationLevel` 只出现在移动端：`"trusted"` \| `"degraded"` \| `"rejected"`。
它只是壳本地解析叶子扩展得到的参考值：服务端一旦验过链，就用自家结论覆盖它——
自报 `"trusted"` 换不来准入，改几行壳代码就能声明的东西不算证据。

返回 `200 { clientId, minimumVersion, outdated }`；判定不过返回 4xx 且
`error` 为可归因码（见 §6）。

### `POST /api/client/challenge`

请求 `{ clientId }` → 返回 `{ challenge, expiresAt }`。
`challenge` 是服务端生成的不透明字符串，形如 `ccd_xxx.nonce.issuedAt`，
TTL 60 秒、单次消费。**壳必须原样签名字节，不做任何二次编码**。

### `POST /api/client/attest`

| 字段 | 说明 |
|---|---|
| `clientId` | 注册返回的 id |
| `challenge` | 上一步原样拿到的串 |
| `signature` | base64。ed25519 = 64 字节裸签名；ec-p256 = **DER (SEQUENCE{r,s})** |
| `clientType` `clientVersion` `selfCheck` | 与注册同形状，每次重报 |

返回 `200 { ticket, expiresAt, outdated }`；不过返回 4xx + `error`。

### `GET /api/client/update-check`

查询串 `{ clientType, clientVersion }`（壳自报，只用来选档位）→ 返回 `{ minimumVersion, outdated }`。
未配置最低版本时 `minimumVersion` 是空串、`outdated` 恒为 `false`。

首页的更新提醒读这一条：比对只在服务端做一次（`compareClientVersion`），前端不实现第二份，
否则两端对「够不够新」的判断会各自漂移。它不参与准入、不改变任何判定——关掉或忽略提醒
都绕不过反作弊房的 `CLIENT_OUTDATED`。响应带 `Cache-Control: no-store`：抬档要立刻生效，
被边缘缓存的旧门槛会让提醒静默失灵。

### `GET /api/client/packages`

无查询串 → 返回 `{ packages: [{ platform, arch, url, available, sizeBytes?, builtAt? }] }`，
`platform` 取 `windows` / `android`，数组顺序即首页弹窗里的顺序。

首页的「下载客户端」弹窗与更新提醒读这一条。构建日期与文件大小**不在前端写死**：
`ClientArtifacts` 对配置里的公开别名发一次 HEAD，把对象存储自己的 `Last-Modified` 与
`Content-Length` 读回来，CI 推包即跟版，不需要谁记得去改页面。读不到（404 = 制品还没推上去、
超时、边缘节点抖动）一律记 `available: false`，前端把下载按钮置灰写「尚未发布」——
不给玩家一个跳 404 的链接。探测结果服务端缓存 60 秒，响应带 `Cache-Control: public, max-age=60`。

地址来自服务端配置 `CLIENT_PACKAGE_WINDOWS_URL` / `CLIENT_PACKAGE_ANDROID_URL`，
默认即 CI `client-publish` 作业推的那两条固定别名；配成空串 = 该平台不进列表。
这条与通道证明无关：通道没启用（`CLIENT_CHANNEL_DISABLED`）时它照样回内容，下载不该被准入相关的开关挡住。

### ws 握手

`/api/cee/ws?clientType=…&clientVersion=…&ticket=…`

网页没有 ticket（也没有密钥），`clientChannel` 即为空。前端**只做存在性探测**：
`window.__BAKA_CHANNEL__` 存在 = 原生客户端，绝不调用其中的 `sign` / `selfCheck`
（见仓库根 `AGENTS.md` 的客户端完整性边界）。ticket 由壳自行签好注入到
`__BAKA_CHANNEL__.channelTicket`，`bakaChannelQuery()` 原样带上。

## 4. 自检项 id 词表

判定表只有一份代码：`Server/src/infrastructure/ClientChannel.ts` 的 `SELF_CHECK_WEIGHTS`。
**壳新增检测项必须同步在这里加一行并抬最低版本**——服务端查不到的 id 失败关闭（拒），
漏跟一项检测不会变成放行，但会变成误伤正常设备。

桌面（`Desktop/src-tauri/src/selfcheck.rs`）报的 id 不带后缀：
`debugger_attached`、`debug_port`、`debug_object_handle`、`debug_query_unavailable`、
`module_not_allowed`、`module_enumeration_failed`、`ldr_list_mismatch`、
`ldr_enumeration_failed`、`parent_process`、`devtools`、`platform_unsupported`。

移动（`Mobile/android/app/src/main/java/website/baka/game/channel/SelfCheck.kt`）的 id
可以带 `:<细节>` 后缀（命中的包名、su 的路径），判定只认冒号前的前缀，后缀留给日志与人工复核：

| id 前缀 | 归类 | 触发条件 |
|---|---|---|
| `accessibility_automation` | 硬 | 已启用的无障碍服务命中自动化外挂名单（Auto.js / AutoX / 按键精灵 / 触动精灵…） |
| `root_su` `root_magisk` | 硬 | su 或 Magisk 目录存在（后缀是命中的路径） |
| `root_test_keys` `root_debuggable` | 硬 | `Build.TAGS` 含 test-keys，或 `ro.debuggable=1` |
| `root_magisk_mount` | 硬 | `/proc/mounts` 里出现 magisk |
| `emulator_build` `emulator_qemu` `emulator_no_accelerometer` | 硬 | 指纹/机型串含模拟器标记、`ro.kernel.qemu=1`、缺加速度计（真机必有） |
| `clone_source_path` `clone_user_data` | 硬 | 安装路径指向宿主包，或落在非 `/data/user/0/` 的用户目录（多开分身） |
| `keystore_unavailable` | 硬 | `AndroidKeyStore` 打不开，签名根本没法做 |
| `accessibility_unknown` | 软 | 已启用的无障碍服务既不在白名单也不在黑名单 |
| `accessibility_check_failed` | 软 | 读无障碍服务列表抛异常 |
| `emulator_no_gyroscope` | 软 | 缺陀螺仪（低端真机也有） |
| `abi_x86` | 软 | 主 ABI 含 x86（极少数真 x86 手机） |
| `media_projection_active` `media_projection_allowed` | 软 | 进程侧探测到录屏服务 / 本 app 被授了投影权限 |
| `clone_user_id` `clone_data_dir` | 软 | 工作资料用户（uid/100000 ≠ 0）或 dataDir 不含自身包名 |

分类（服务端判定的依据，壳只负责报 id）：

| 桌面 id | 归类 |
|---|---|
| `debugger_attached` `debug_port` `debug_object_handle` `module_not_allowed` `ldr_list_mismatch` | 硬失败 |
| `debug_query_unavailable` `module_enumeration_failed` `ldr_enumeration_failed` | 硬失败（检测跑不动 = 有人让它在跑不动） |
| `parent_process` `devtools` | 软失败 |
| `platform_unsupported` | 不计分，但标 `suspect`（非 Windows 构建：没跑成检测，也不能当成「跑过且干净」） |
| DPAPI 不可用（`keyProtection = "software"`） | 环境降级，不计分 |

按**权重**判，不按壳填进了哪一格判：硬失败 id 出现在 `softFail` 里一样是拒。
`attestationLevel` 不在这张表里，走 §5 的三档。

## 5. 判定：按「完整性是否被破坏」，不按「证明强度够不够」

- 任一**硬失败** → `CLIENT_UNTRUSTED`。
- **软失败 ≥ 2** → `CLIENT_UNTRUSTED`。
- 软失败 = 1 → 放行，`integrity: "suspect"`。
- 仅 DPAPI 不可用 / 无 TEE / 证书过期 → **放行**并标记（设备太老是能力不足）。
- 移动端 `attestationLevel = "rejected"`（链验不过、被吊销、bootloader 解锁、
  boot 状态非 Verified、签名摘要不匹配）→ `CLIENT_UNTRUSTED`；`"degraded"` → 放行并标记。

### 平台证明只在注册验一次

链由服务端自己验（`Server/src/infrastructure/AndroidAttestation.ts`：内置 Google 新旧两把硬件根
与两把软件根、CRL 走带缓存的拉取），结论写进 `client_channel_device.attestation_level`，
之后每次握手都**以这一档为准**、不再回头看壳的自报值。三条边界：

- `ANDROID_ATTESTATION_PACKAGE` 没配 → 不装配校验器，带链注册只记 `"degraded"` 并警告一次；
  服务端没验过的链不能写成「验过但降级」，也不能因为配置缺失把真实设备挡在门外。
- `ANDROID_ATTESTATION_SIGNATURE_DIGESTS` 是逗号分隔的 base64（每个 = 一枚签名证书 DER 的 SHA-256）。
  不配只标记 `signature_digest_unverified` 并封顶 `"degraded"`：光认包名防不住重打包后自签同名 APK。
  配了则证明里的任一摘要命中列表即通过（与 Google 参考实现同口径，签名轮换期会同时列出新旧两枚），
  全不命中判 `signature_digest_mismatch` → `CLIENT_UNTRUSTED`。怎么取出这串摘要见
  [Mobile/README.md §7](../Mobile/README.md)——那一步必须在真机上装过包之后再确认，换签名的 APK
  与经商店二次签名的 APK 读出来的不是同一个值。
- 链的叶子公钥必须等于本次 `publicKey`，否则 `ATTESTATION_REJECTED`：attestation challenge
  是设备自报的（服务端没下发过 nonce），没有这层绑定，一条合法链可以在设备之间任意转借。
- 重新注册按这一次的结果覆盖档位：上次验出的结论不替「密钥已换」担保。

## 6. 错误码

| 码 | 含义 | 出现处 |
|---|---|---|
| `CLIENT_REQUIRED` | 反作弊房拒绝无通道证明的连接 | 建房与进房（`cee.room.create` / 加入 / 重连） |
| `CLIENT_UNTRUSTED` | 自检或证明判定不过 | register / attest |
| `CLIENT_OUTDATED` | 低于服务端最低支持版本 | 反作弊房准入：建房与进房（普通房不拦） |
| `CLIENT_UNKNOWN` | ticket / challenge 引用未注册的 clientId | challenge / attest |
| `CHALLENGE_EXPIRED` | 挑战过期或已被用过 | attest |
| `ATTESTATION_REJECTED` | Android 证书链验证失败（只可能在注册时做） | register |
| `LOGIN_REQUIRED` | 反作弊房要求全员已登录 | 建房与进房 |

## 7. 强制更新

最低支持版本放在服务端配置（`CLIENT_MIN_DESKTOP_VERSION` / `CLIENT_MIN_MOBILE_VERSION`），
不发版也能紧急抬升。`attest` 与 `register` 都回 `outdated`，并把 `clientVersion` 记进
`clientChannel`；反作弊房准入时版本低于最低值即 `CLIENT_OUTDATED`。
**通道证明协议一旦破坏性变更必须抬高最低版本**，否则旧壳还能继续签名通关。

更新提示分两级，读同一份最低版本：

- **首页软提醒**（`Client/src/components/ClientUpdateNotice.tsx`）只在原生壳里出现，可关。
  关的是「这一档门槛」，服务端抬档后提醒重新出现；普通房间照常游玩，措辞必须写明这点。
  「下载最新版」按壳自报的类型给对应平台的包（桌面→exe、移动→APK），读的是
  `/api/client/packages`；`available: false` 时整颗按钮不出现，不留一枚跳 404 的链接。
- **反作弊房硬门槛**（`CEERooms.requireClientAdmission`，建房与进房共用）不看玩家关没关过提醒，
  版本低于最低值即 `CLIENT_OUTDATED`。提醒只是让玩家早点动手，从来不是准入的一部分。
