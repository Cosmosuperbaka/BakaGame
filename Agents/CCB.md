# CCB（猜动漫角色 · 增强版）领域规范

CCB 是平台第三个游戏，与 WhoIsFaker、Songuessr 架构地位完全对等（`Spec.md §11`）。
玩法移植自独立仓库 `anime-character-guessr`，但**只复刻玩法**：
技术栈、协议、房间模型、状态机框架一律使用本项目既有两个游戏的范式，不沿用原版的实现方式。

- **命名**：标识符一律 `CCB`（严禁 `CCB`），路由与命名空间一律 `ccb`，详见 `Conventions.md §1.1`。
- **数据**：角色数据来自本地只读 `bangumi-character.sqlite`，字段口径与更新链路见 `BangumiApi.md`。
- **上游玩法真相源**：`anime-character-guessr`（原版前端 `client/src/utils/bangumi.js`）与
  `CCBFilter`（从 dump 提取的全量角色推导结果，用于对拍）。

---

## 1. 服务端权威边界

原版把**出题**与**部分判定**放在客户端，本项目一律收归服务端：

| 能力 | 原版 | 本项目 |
|---|---|---|
| 抽题 | 客户端随机抽角色后 AES 加密上传 | 服务端从本地 SQLite 出题，答案不出服务端 |
| `isPartialCorrect` | 客户端上报后被信任 | 服务端依据本地数据自行判定 |
| 反馈判定 | 客户端解密答案后本地算 | 服务端算完只下发给猜测者本人（`CCBPrivateState.ownGuesses`） |
| 猜测次数 / 超时 | 客户端计时 | 服务端权威计时 + `runHousekeeping` 巡检兜底 |

客户端**不允许**提交任何形如「我已猜对」的结论字段：`ccb.game.guess` 只收 `characterId`。

## 2. 传输与协议

- WebSocket 入口：`/api/ccb/ws`，与另两个游戏共信封（`ClientEnvelope` / `AckPacket` / `ErrorPacket` / `EventPacket`）。
- 解析器：`Server/src/transport/CCBProtocol.ts` 导出 `parseCCBMessage`，TypeBox 单一真相源，
  所有 Schema 均 `additionalProperties: false`。
- 状态事件：`CCB_STATE_EVENTS` 的 `ccb.room.snapshot` 与 `ccb.game.privateState` **必须**登记进
  `Server/src/transport/StateSync.ts` 的 `STATE_EVENTS`。该表是硬编码白名单，漏登记会让每次广播
  都退化成全量推送并打穿 `Spec.md §7` 的 6 Mbps 预算；`StateSync.test.ts` 有对应回归用例。
- 聊天与玩家自定义短消息只走状态通道（`snapshot.chat` / `player.message`），**不额外发事件**，
  以免同一事实出现两个生产通道。

### 传输层两层约束范式

载荷上限与展示上限是两件事，不要合并成一层：

| 字段 | Schema 上限（防 OOM） | 服务端归一化 |
|---|---|---|
| `ccb.chat.send.text` | 500 | `normalizeWord` + 截断 200 |
| `ccb.player.setMessage.message` | 200 | `normalizeWord` + 截断 `CCB_PLAYER_MESSAGE_LIMIT`(32) |

## 3. 房间生命周期

沿用本项目数值（不是原版的数值），常量在 `Server/src/config/Constants.ts`：

| 场景 | 行为 |
|---|---|
| 房主断线 | 保留席位与房主身份 `HOST_RECONNECT_TIMEOUT_MS`(60 s)，超时转移给最早加入的在线正式玩家 |
| 全员离线 | 进入 `ROOM_EMPTY_GRACE_PERIOD_MS`(90 s) 宽限，期内只做状态校准，超时按 `empty` 关房 |
| 房间空置 | 有在线玩家但 `ROOM_IDLE_TIMEOUT_MS`(10 min) 无活动 → 按 `idle_timeout` 关房 |
| 掉线玩家 | `PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS`(3 min) 后清出房间并重新指派房主 |
| 巡检节奏 | `Server/src/Index.ts` 的 10 s 定时器调用 `runHousekeeping` |
| 测试房间 | 房间号 `Oblivionis`（`ROOM_ID_TEST_MODE`）不参与自动清理，也不出现在大厅 |
| 0 分旁观者掉线 | 立即释放席位（不占房间成员，无重连价值） |

`hostPlayerId` 是房主身份的唯一真相源；`isHost` / `testMode` 一律派生，不落库、不存第二份。

## 4. 移植原则：复刻玩法而不是照搬代码

- **允许**逐条照抄的只有**规则本身**：数值阈值、判定条件、标记字符、计分公式、高亮与箭头方向。
- **禁止**照搬原版的代码结构：Express/socket.io/MongoDB 的调用方式、客户端可信判定、
  `Map`/`Set` 内存态、无超时兜底的写法定然不移植。
- 每个原版规则落地前，先写进本文件对应的判定表，再写测试，最后才是实现——判定表是唯一真相源，
  防止「看着像就改了」。

## 5. 原版缺陷修复登记（7 项，逐项必须在本文件留痕）

| # | 原版缺陷 | 本项目处置 | 状态 |
|---|---|---|---|
| 1 | 客户端抽题 + AES 密钥下发 + `/api/room-info` 泄露答案密文 | 服务端出题，答案不出服务端 | 待 P1 |
| 2 | `isPartialCorrect` 由客户端上报并被信任 | 服务端依据本地数据判定 | 待 P1 |
| 3 | `⏱️` 是双码点（`U+23F1 U+FE0F`），`Array.from` 长度算 2 → `guessCount` 虚高、`quickGuess` 加成判定偏差 | 标记计数一律用 `countAttemptMarks`（正则整体匹配），严禁按字符长度算 | 待 P1 |
| 4 | `syncPlayersCompleted` / `globalPickState` 用 `Map`/`Set` 只在内存，重启即失 | 改为可序列化派生结构，保留原版「从猜测历史重建」的自愈思路 | 待 P2 |
| 5 | 无任何服务端限流（`createRoom`、`playerGuess`、`tagBanSharedMetaTags` 尤甚） | 在服务端补事件限流 | 待 P1 |
| 6 | `startAutoClean` 被调用两次（两组 interval 重复注册）；`/api/quick-join` 注释说排除进行中房间但代码没过滤 | 不移植这两个实现，本项目的清理只由 `runHousekeeping` 单一入口驱动 | ✅ 天然规避 |
| 7 | 无硬超时兜底（只有软计时） | 每个阶段都带 `hardDeadlineAt`，由 `runHousekeeping` 强制推进（`Spec.md §9.2`） | 待 P1 |

## 6. 玩法规格（P1 起落地的判定真相源）

### 6.1 阶段

`waiting → answering → guessing → settled`（`CCB_PHASES`）。原版没有显式 phase，靠
`currentGame` / `waitingForAnswer` / `answerSetterId` 组合推导；本项目收敛为显式枚举与迁移表。

### 6.2 标记体系

- 尝试类：`⏱️`（超时）`💡`（提示）`✔`（猜对）`❌`（猜错）
- 结束类：`✌`（本局完成）`👑`（大赢家）`💀`（淘汰）`🏳️`（投降）`🏆`（最终冠军）
- 去重：结束类标记用 `appendEndMarkOnce`，同一标记不重复追加。

### 6.3 反馈判定（8 个字段，逐条复刻）

| 字段 | 判定 |
|---|---|
| `gender` | 相等 → `yes`，否则 `no`；非 `male/female` 一律归一为 `?` |
| `popularity` | `diff = guess − answer`；`abs(diff) ≤ 5%` → `=`；`diff > 0` → `≤20% ? '+' : '++'`；`diff < 0` → `≥−20% ? '-' : '--'` |
| `rating`（最高分） | 任一方 `−1` → `?`；`abs(diff) ≤ 0.3` → `=`；`diff > 0` → `≤1 ? '+' : '++'`；否则 `-` / `--` |
| `appearancesCount` | `0 → =`；`> 0 → ≤2 ? '+' : '++'`；`< 0 → ≥−2 ? '-' : '--'` |
| `latestAppearance` / `earliestAppearance` | 同作品数；任一方 `−1` → `?`；双方均 `−1` → `=` |
| `shared_appearances` | **用 `appearanceIds` 求交集**（不是作品名），产出 `{first, firstOriginal, firstCn, count}` |
| `metaTags` | 作品标签 ∩ + 角色标签 ∩（`id_tags`）+ CV 交集；shared 优先补足到 `subjectTagNum` / `characterTagNum` |

**高亮与箭头（反直觉，务必照抄）**：

- 绿 = `yes` / `=`；黄 = `+` / `-`；`?` 灰。
- 箭头：`+*` → `↓`（提示往低猜），`-*` → `↑`（提示往高猜）。

### 6.4 计分

基础分 2；大赢家 +12；好快的猜 +2 / +1；作品分 +1；出题人分按其他玩家表现结算。
`CCBRules.ts` 必须是**纯函数**，先写表驱动测试再接服务端。

## 7. 阶段落点

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 数据地基、契约、协议与传输、房间骨架、房间生命周期测试 | ✅ 已完成 |
| P1 | `domain/CCBRules.ts`、服务端出题与猜测、权威计时、前端对局界面 | 待办 |
| P2 | 同步模式、血战模式、标签全局 BP、角色全局 BP | 待办 |
| P3 | 手动出题、队伍模式、提示系统、观战增强视图 | 待办 |
| P4 | 兼容原版房间（服务端桥接） | 待办，方案见 `tasks/ccb-enhanced-multiplayer-migration-plan.md §5` |

对局类指令（`ccb.character.search` 与 `ccb.game.*`）的 wire 格式已在 `shared/CCB.ts` 固化，
但 **P1 才挂载 Schema**；在此之前发送会得到 `UNKNOWN_MESSAGE_TYPE`，这是有意为之——
宁可明确报错，也不向客户端宣称尚不可用的能力（`CCBPrivateState` 里 `canGuess` / `canStartRound`
等能力位在 P0 一律为 `false`）。
