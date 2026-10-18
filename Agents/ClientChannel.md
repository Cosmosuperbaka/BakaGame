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
| `attestation` | 移动 | `{ attestationChallenge, chain }`，`chain` 是 PEM 数组（叶子在前） |

`selfCheck` 形状：`{ hardFail: string[], softFail: string[], keyProtection?, attestationLevel? }`
`attestationLevel` 只出现在移动端：`"trusted"` \| `"degraded"` \| `"rejected"`。

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

### ws 握手

`/api/cee/ws?clientType=…&clientVersion=…&ticket=…`

网页没有 ticket（也没有密钥），`clientChannel` 即为空。前端**只做存在性探测**：
`window.__BAKA_CHANNEL__` 存在 = 原生客户端，绝不调用其中的 `sign` / `selfCheck`
（见仓库根 `AGENTS.md` 的客户端完整性边界）。ticket 由壳自行签好注入到
`__BAKA_CHANNEL__.channelTicket`，`bakaChannelQuery()` 原样带上。

## 4. 自检项 id 词表

桌面（`Desktop/src-tauri/src/selfcheck.rs`）：
`debugger_attached`、`debug_port`、`debug_object_handle`、`debug_query_unavailable`、
`module_not_allowed`、`module_enumeration_failed`、`ldr_list_mismatch`、
`ldr_enumeration_failed`、`parent_process`、`devtools`、`platform_unsupported`。

分类（服务端判定的依据，壳只负责报 id）：

| id | 归类 |
|---|---|
| `debugger_attached` `debug_port` `debug_object_handle` `module_not_allowed` `ldr_list_mismatch` | 硬失败 |
| `debug_query_unavailable` `module_enumeration_failed` `ldr_enumeration_failed` | 硬失败（检测跑不动 = 有人让它在跑不动） |
| `parent_process` `devtools` | 软失败 |
| `platform_unsupported` | 不计分，仅标记 |
| DPAPI 不可用（`keyProtection = "software"`） | 环境降级，不计分 |

移动（`Mobile/android/.../SelfCheck.kt`）id 另列，按同一套硬/软口径归类，
`attestationLevel` 单独走 §5 的三档。

## 5. 判定：按「完整性是否被破坏」，不按「证明强度够不够」

- 任一**硬失败** → `CLIENT_UNTRUSTED`。
- **软失败 ≥ 2** → `CLIENT_UNTRUSTED`。
- 软失败 = 1 → 放行，`integrity: "suspect"`。
- 仅 DPAPI 不可用 / 无 TEE / 证书过期 → **放行**并标记（设备太老是能力不足）。
- 移动端 `attestationLevel = "rejected"`（链验不过、被吊销、bootloader 解锁、
  boot 状态非 Verified、签名摘要不匹配）→ `CLIENT_UNTRUSTED`；`"degraded"` → 放行并标记。

## 6. 错误码

| 码 | 含义 | 出现处 |
|---|---|---|
| `CLIENT_REQUIRED` | 反作弊房拒绝无通道证明的连接 | ws 之后的业务命令 |
| `CLIENT_UNTRUSTED` | 自检或证明判定不过 | register / attest |
| `CLIENT_OUTDATED` | 低于服务端最低支持版本 | 反作弊房准入（普通房不拦） |
| `CLIENT_UNKNOWN` | ticket / challenge 引用未注册的 clientId | challenge / attest |
| `CHALLENGE_EXPIRED` | 挑战过期或已被用过 | attest |
| `ATTESTATION_REJECTED` | Android 证书链验证失败 | register / attest |
| `LOGIN_REQUIRED` | 反作弊房要求全员已登录 | 业务命令 |

## 7. 强制更新

最低支持版本放在服务端配置（`CLIENT_MIN_DESKTOP_VERSION` / `CLIENT_MIN_MOBILE_VERSION`），
不发版也能紧急抬升。`attest` 与 `register` 都回 `outdated`，并把 `clientVersion` 记进
`clientChannel`；反作弊房准入时版本低于最低值即 `CLIENT_OUTDATED`。
**通道证明协议一旦破坏性变更必须抬高最低版本**，否则旧壳还能继续签名通关。
