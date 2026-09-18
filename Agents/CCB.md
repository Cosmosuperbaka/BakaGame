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

## 5. 原版缺陷修复登记（8 项，逐项必须在本文件留痕）

| # | 原版缺陷 | 本项目处置 | 状态 |
|---|---|---|---|
| 1 | 客户端抽题 + AES 密钥下发 + `/api/room-info` 泄露答案密文 | 服务端出题，答案不出服务端 | 待 P1 |
| 2 | `isPartialCorrect` 由客户端上报并被信任 | 服务端依据本地数据判定 | 待 P1 |
| 3 | ~~`⏱️` 是双码点（`U+23F1 U+FE0F`）导致 `guessCount` 虚高、`quickGuess` 加成偏差~~ —— **实测不成立，原判断有误**：`calculateWinnerScore` 的 strip 字符类 `/[✌👑💀🏳️🏆]/` 里含 FE0F，会把 `⏱️` 一并剥成单码点 `⏱`，**两条路径都按 1 次计** | 仍保留两套计数函数（次数上限用正则、加分档位用码点），并各写回归用例钉死行为；`⏱️` 与 `🏳️` 的 FE0F 必须照抄进字符类，**擅自去掉 FE0F 会真的把两条路径改成不一致** | ✅ 已核实 |
| 4 | `syncPlayersCompleted` / `globalPickState` 用 `Map`/`Set` 只在内存，重启即失 | 改为可序列化派生结构：`round.syncCompletedPlayerIds: string[]`（P2）、`globalPick` 改从猜测历史重建「谁猜过哪个角色」 | ✅ 已落地 |
| 5 | 无任何服务端限流（`createRoom`、`playerGuess`、`tagBanSharedMetaTags` 尤甚） | 在服务端补事件限流 | 待 P1 |
| 6 | `startAutoClean` 被调用两次（两组 interval 重复注册）；`/api/quick-join` 注释说排除进行中房间但代码没过滤 | 不移植这两个实现，本项目的清理只由 `runHousekeeping` 单一入口驱动 | ✅ 天然规避 |
| 7 | 无硬超时兜底（只有软计时） | 每个阶段都带 `hardDeadlineAt`，由 `runHousekeeping` 强制推进（`Spec.md §9.2`） | 待 P1 |
| 8 | **同步模式会永久卡死**：`updateSyncProgress` 开头 `if (syncPlayers.length === 0) return;`，于是「全员 `💀` 且无人猜中」时没人再触发推进，`phase` 永远停在 `guessing` | `resolveCCBSyncVerdict` 把「参战玩家归零」判为 `settle` 直接收尾，见 §6.6 | ✅ 已修复 |

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
| `popularity` | `diff = guess − answer`，阈值以**答案**为基准：`abs ≤ 5%` → `=`；`diff > 0` → `≤20% ? '+' : '++'`；`diff < 0` → `≥−20% ? '-' : '--'` |
| `rating`（最高分，**不是平均分**） | 任一方 `−1` → `?`；`abs ≤ 0.3` → `=`；`diff > 0` → `≤1 ? '+' : '++'`；否则 `≥−1 ? '-' : '--'`。⚠️ `guess` 字段**保留原值 `−1`**（只有年份字段才换成 `?`）；⚠️ 边界在 IEEE754 下**不对称** —— `8.3−8 = +0.3000000000000007` 给 `+`，`7.7−8 = −0.2999999999999998` 给 `=`，必须照抄 |
| `appearancesCount` | 差为 `0` → `=`；`> 0` → `≤2 ? '+' : '++'`；`< 0` → `≥−2 ? '-' : '--'` |
| `latestAppearance` / `earliestAppearance` | 任一方 `−1` 时：**双方都 `−1` → `=`**，否则 `?`；两侧都有值时 `0 → =`、`>0 → ≤2 ? '+' : '++'`、`<0 → ≥−2 ? '-' : '--'` |
| `shared_appearances` | **两套口径并存**：`first` 按**作品名**求交集；`firstOriginal` / `firstCn` 按 **subject id** 求交集取首个；`count` 优先取 id 交集大小、为空时**回落**到名字交集大小 |
| `metaTags` | `commonTags` 模式：作品标签与角色标签各「先取交集、再用非交集项补足」到 `subjectTagNum` / `characterTagNum`，声优取交集**不截断**，`shared` 只含三类交集；默认模式：`guess` 全量、`shared` 取交集 |

**高亮与箭头（反直觉，务必照抄）**：

- 绿 = `yes` / `=`；黄 = `+` / `-`；`?` 灰。
- 箭头：`+*` → `↓`（提示往低猜），`-*` → `↑`（提示往高猜）。

### 6.4 标记与计分（P1 落地）

真相源 `server/utils/gameplay.js`；落地在 `Server/src/domain/CCBRules.ts`，
表驱动用例在 `Server/test/CCBRules.test.ts`。**改规则先改这里，再改实现。**

标记存在 `player.guesses`（字符串），队伍模式另有 `room.currentGame.teamGuesses[teamId]`。

| 标记 | 触发条件 | 追加方式 |
|---|---|---|
| `⏱️` | 服务端计时到期 | `+=`（**可叠加**；队伍模式追加队友数份并覆盖到全体队友） |
| `💡` | 猜错但 `shared_appearances.count > 0` | `+=` |
| `✔` | 猜对 | `+=` |
| `❌` | 猜错且无共同作品 | `+=` |
| `✌` / `👑` | 猜对后结算 | `stripEndMarks + mark`，**顺序是先 `✔` 再追加**，成品形如 `...✔✌`；隐式去重 |
| `💀` | 次数用尽（`enforceAttemptLimit`） | 剥离式去重（**唯一使用 `appendEndMarkOnce` 的地方**） |
| `🏳️` | 投降（`enterObserverMode`） | 剥离式去重。**次数已用尽时记 `💀` 而不是 `🏳️`** |
| `🏆` | 队伍模式下**其他队友**收到「队友猜对」 | `includes` 检查后 `+=`；同时把队友置为 `_tempObserver` |

**两套「次数」计数器，务必分清，不要合并**：

- `countCCBAttemptMarks(marks)`：正则 `/(?:⏱️?|💡|✔|❌)/g` 整体匹配 —— 用于**次数上限**判定、
  剩余次数显示、大赢家判定（`=== 1`）。这是「次数」的唯一权威。
- `calculateCCBWinnerScore({guesses}).guessCount`：先 `replace(/[✌👑💀🏳️🏆]/g,'')` 再数**码点** ——
  只用于**好快的猜分档**。实测两者对 `⏱️` 都给 1（见 §5 缺陷 #3）。

**计分**：

| 项 | 规则 |
|---|---|
| 基础分 | 普通/同步固定 `2`；血战 `base = max(1, 初始参战人数 − 此前已胜人数)` |
| `quickGuess` | 仅非大赢家：`guessCount ∈ [2,3]` → `+2`；`∈ [4, ceil(totalRounds/2)]` → `+1`；其余 `0`。**按已用次数分档，不是按剩余时间** |
| `bigWin`（`👑`） | 固定 `+12`。产生条件 = **首次猜测即猜中** 或 **本命头像 `avatarId` 就是答案角色**（**不是**「唯一猜对」/「第一个猜对」） |
| 作品分 | `+1`，仅给「猜错但同作品」中**每个队伍的第一次**（同序号按用户名升序破平），且**胜者不参与**；`breakdown.partial = 1` |
| 出题人（普通/同步） | 大赢家 → `−max(1, ⌊大赢家得分/2⌋)`「纯在送分」；有胜者且次数 `≤3` → `−1`「太简单了」；`> totalRounds/2` → `+1`「难度适中」；其余 `0`；**无胜者 → `−1`「没人猜中」** |
| 出题人（血战） | 大赢家同上；无胜者 → `−2 × max(1, ⌈参战人数/2⌉)`；否则按猜中率 `≤0.25`→`1×`「难度偏高」、`≥0.75`→`1×`「难度偏低」、其余`2×`「难度适中」，乘数 = `max(1, ⌈参战人数/2⌉)` |
| 猜错 / 超时 / 投降 | **一律不扣分**。唯一可能为负的只有出题人 |

**结束条件**：次数用尽 → `💀`（**淘汰语义，但不移出房间、只禁猜**；队伍共享计数，任一成员耗尽即全队 `💀`）；
普通模式**一旦出现胜者立即结算**；同步模式要等本轮全员完成（`syncReadyToEnd`）；
血战要等 `remainingPlayers` 归零。投降后**留在房间观战**（`_tempObserver`）。

这三条分流在服务端**只由一个入口**判定：`CCBService.advanceOrSettle`（原来叫 `settleIfRoundEnds`，
P2b 起改名，因为同步模式在这里除了结算还会推进轮次）。判定表见 §6.6。

**P1b 落地时的四处取舍（增强版特有，务必先看这里再改代码）**：

1. **出题人分只在「真人出题」时结算**（P3a 起）。判定依据是 `CCBRoundRecord.answerIsManual`：
   服务端抽题的房间里 `answerSetterPlayerId` 只是**记成房主**，原版那套惩罚/奖励没有对象，
   照抄等于凭空给房主加减分；手动出题才是真出题人。两套口径由 `resolveCCBSetterScore`
   按模式**选表**（普通/同步看首个胜者的标记与次数，血战看猜中率），它本身不算分。
   ⇒ 与「兼容原版房间」对局时那边必须照原版算 —— 这是**逐项登记在 §5 之外**的一处
   已知差异，不与 §5 的编号共用。
2. **人机不参与猜测**（P1b 限制）。`beginRound` 把人机直接置为 `finished`，否则 `allSettled` 永远为假、
   整局卡死。人机仍占正式席位与被计分玩家列表，只是不猜。
3. **出题人自己也算「本局已结束」**。同一原因：出题人不猜，若不计入 `finished`，普通模式以外的
   收尾判定（P2）会永久阻塞。**这是踩过的坑**：第一版漏了它，导致结算永远不触发。
4. **权威计时靠 housekeeping**（10 s 一次），不是每局一个 `setTimeout`。因此限时到点最多晚 10 s 生效；
   代价是没有定时器泄漏、房间销毁时无需逐个清理。到点写 `⏱️ + 💀`（`⏱️` 计入尝试次数，与原版一致）。

> ⚠️ 附带一条容易误判的计数事实：`💡` 也是尝试标记（正则 `/(?:⏱️?|💡|✔|❌)/g` 含它），
> 所以**一次「猜错但沾边」按 2 次计**，剩余次数会掉 2。这是原版口径，不是 bug，别"修正"。

### 6.5 数据层规则（P0 已落地，P1 只消费）

`CCBRules.ts` 的输入全部来自本地 `bangumi-character.sqlite`，**不联网**。原版的每一条
数据规则都在构建期对齐（`tools/build_bangumi_db.py`），明细见 `BangumiApi.md §本地数据集构建`。
这里只记「P1 必须知道」的三件事：

1. **标签池是房间设置的函数，必须运行时算。** `getCharacterAppearances` 先按
   `gameSettings.metaTags` 推出 `bigTypes`（默认 `[2]`；`else if` 链：游戏→`[4]`、
   书籍→`[1]`、三次元→`[6]`、全部→`[1,2,4,6]`）过滤登场作品，**过滤后为空则回退到全部类型**，
   再由 `commonTags` / `subjectTagNum` / `characterTagNum` 决定截断。**库里没有、也不许有
   标签池列**——任何物化都把某一种设置写死。
2. **`details.tags` 与 `details.raw_tags` 是两份不同的数据。**
   `raw_tags = subjects.raw_tags`（全类型、未过滤）；
   `tags = (type ∈ {2,4}) ? raw_tags 剔除标签名含 "20" 的项 : {}`。
   标签累积的普通标签循环用 `tags`，`commonTags` 分支用 `raw_tags`（它在合并后才做 "20" 过滤）。
3. **登场作品同样是「关联 × 作品」的函数，运行时联表算，不落库。** 规则、SQL 与两处顺序
   （**累积按 `subject_id` 升序、输出按 `rating_count` 降序**）见 `BangumiApi.md §登场作品`。
4. **`rating_count` 是输出排序依据**，等于 dump 的 `score_details` 直方图求和（≈ API 的
   `rating.total`）；`shared_appearances` 的「第一个共同作品」依赖这个顺序。
5. **数据访问全在 `infrastructure/CCBCharacterRepository.ts`**：`pickRandomSubject` /
   `pickRandomCharacter`（两级采样）、`buildCharacterView`（反馈视图）、`searchCharacters`
   （**短于 3 字必须回退 LIKE**，FTS5 trigram 对短查询必然 0 命中）。
   实测 `buildCharacterView` 平均 **1.3 ms**（10 个代表性角色 × 20 轮），无需缓存。

**已知差异（无法还原，P1 需按此口径实现）**：

| 项 | 原版 | 本项目 | 影响 |
|---|---|---|---|
| `locked` 作品 | `getSubjectDetails` 返回 null → 丢弃 | dump 无该字段 → 保留 | 极少数被锁定条目会多出一条登场作品 |
| `nsfw` 作品 | **不检查**，正常纳入 | **一律剔除**（合规要求，见下） | 题库与登场作品都不再出现成人向标题 |
| `animeVAs` 顺序 | API 返回顺序（`Set` 插入序） | dump 关系文件顺序 | 仅影响 CV 标签的显示先后 |

#### `nsfw` 剔除（2026-09-18 的合规决定）

原版从不看 `nsfw`，成人向作品标题会直接进反馈。**本项目一律剔除**，两条路一起走：

| 层 | 位置 | 作用 |
|---|---|---|
| 构建期（根治） | `tools/build_bangumi_db.py` | nsfw 作品**不进角色库**，其 `character_subject_relations` 一并丢弃（否则留下指向不存在作品的悬空行）；`report_character_stats` 增加守卫：**`subjects_nsfw != 0` 直接构建失败** |
| 运行期（边界） | `infrastructure/CCBCharacterRepository.ts` | `pickRandomSubject` 与 `loadAppearances` 各加 `nsfw = 0` —— 保证**已发布的 LFS 实体**（尚未重建）也立刻合规 |

⚠️ **`hasAnyRelation` 刻意不改**：那个哨兵的语义本来就是「有原始关联、但过滤后为空 →
`highestRating: -1`（不可比）」，nsfw 过滤正好落在它设计好的分支里。伸进去会把 `-1` 变成 `0`，
反而破坏原版语义。

**范围**：只剔除**角色库**。歌曲库的 `subjects` 只存动画，而「NSFW 动画进不进歌曲题库」是
另一个产品决定，硬塞进来会连带改动 Songuessr 题库 —— 因此 dump 里那 2,520 部 nsfw 动画
**仍留在歌曲库**（角色库一个不留）。要一起剔的话，改 `build()` 里 `nsfw_subject_ids` 的用法即可。

**影响面（实测 2026-09-18 的实体，SQL 级对比）**：

| 口径 | 剔除前 | 剔除后 | 变化 |
|---|---|---|---|
| 作品池 | 583,979 | 534,277 | −49,702（书籍 21,544 / 游戏 25,580 / 动画 2,520 / 三次元 58） |
| 主角·配角登场候选（关系 × 作品） | 185,800 | 129,579 | **−56,221（30.3%）** |
| 主角/配角引用到的作品数 | — | — | nsfw 占 12,980 部 |

逐个角色看更直观：`アリス` 49 条 → **8 条**、`ランス` 37 → 9、`井河アサギ` 15 → **1** ——
这几个正是成人向游戏角色，剔除效果符合预期。默认题库（动画近十年）只掉 8%，
但**游戏/Galgame 大类掉约 23%**。

另有 **43,188 个角色的作品全部是 nsfw** —— 他们永远不会成为答案（抽样走作品），
只能被玩家搜到，且反馈里的登场作品为空（`highestRating` 因上面的哨兵给 `-1`）。

> ⚠️ **尚未重建的 LFS 实体**：HEAD 里提交的 `bangumi-character.sqlite` 仍是 114.1 MiB 的旧世代
> （`subjects` 没有 `raw_tags`/`rating_count`/`heat`，也没有 `character_tags`/`character_vas`），
> 而当前代码依赖这些列 —— 也就是说**必须重建一次数据集，CCB 才能在真实数据上跑起来**。
> 这也是构建期剔除必须同时做的原因：重建那一次就会把 nsfw 彻底挡在库外。

**CCBFilter（`CCBFilter`）差异登记** —— 它是同一份 dump 的另一个消费者，**不是真相源**，
有下列刻意差异，对拍时不要照它改：

| # | CCBFilter 的行为 | 原版（本项目采用） |
|---|---|---|
| 1 | 无条件排除 `type=3`（音乐）作品 | 大类过滤为空时**回退到全部类型**，会纳入音乐 |
| 2 | 无条件排除 `nsfw=true` 作品 | ~~从不引用 `nsfw`~~ → **2026-09-18 起本项目也排除**，这一条不再是差异 |
| 3 | 登场作品按 dump 文件顺序 | 按 `rating_count` 降序 |
| 4 | `extractAnimeVAs` **不过滤** `subject_type`，且用 `nameCn \|\| name` | 过滤 `subject_type ∈ {2,4}`，用 `name` |
| 5 | `metaTags` 是自算的一套池（含角色标签与声优） | `allMetaTags` 由 `subjectTagNum` 截断后才拼角色标签与地区标签 |
| 6 | 标签池放**全部**来源标签 | 只放权重最高的那一个 |

对拍脚本在 `.workbuddy/tmp/diff-ccb.ts`（临时件，不入库）。110 个抽样角色的结论：
`popularity` / 登场作品明细 / `latest`·`earliest`·`highest` / 排序 全部一致；
「多出的作品」经断言**100% 由音乐类型或 nsfw 解释** —— 其中 nsfw 那一半**已随本次剔除消失**，
所以现在重跑对拍应当只剩音乐类型这一个解释；角色标签的少量差异来自上游标签快照版本
（本库用 421 标签的新快照，CCBFilter 用 dump 里的旧快照 372 标签）。

### 6.6 三种模式的差异

原版用 `syncMode` + `nonstopMode` 两个布尔，**且 `nonstopMode` 会覆盖 `syncMode`**
（`gameplay.js:899` 写的是 `syncMode && !nonstopMode`）；本项目收敛成 `mode` 枚举，与三者一一对应。

| | 普通 `normal` | 同步 `sync` | 血战 `bloodbath` |
|---|---|---|---|
| 推进单位 | 无轮次，出胜者即结算 | `syncRound` 递增，**全员完成才进下一轮** | 进度制（`remainingCount`），与轮次无关 |
| 胜者集合 | 单个（`👑` 优先于 `✌`） | 本轮所有 `✌`/`👑` | `nonstopWinners` 按猜对顺序累积，**每猜中一个就加一次分** |
| 队友得分 | `0`（`result: 'teamwin'`） | **共享胜者分数**（队友字符串被 `syncTeamGuesses` 覆盖成含 `✌`，于是全队进胜者集合） | `0`（`result: 'teamwin'`） |
| 每人猜测次数 | 无限制（猜到 `💀` 为止） | **每轮 1 次**，猜完要等下一轮 | 无限制（猜到 `💀` 为止） |
| 超时 | 重置本人计时 | 视为本轮完成 | 同普通 |
| 结算触发 | 出现胜者 或 全员结束 | 本轮全员完成且已有胜者 | `remainingPlayers` 归零 |
| 胜者分底分 | `2` | `2` | `max(1, 参战人数 − 已胜人数)` |
| 胜者分是否共享 | 唯一胜者，无此问题 | **所有胜者共享首个胜者的分数** —— 原版用首个胜者的标记串算一次，再 `forEach` 广播给全体胜者 | 各自按名次算 |
| 胜者分发放时机 | 结算时 | 结算时 | **猜对当场** —— 结算阶段必须跳过，否则双倍计分 |

**同步模式的推进判定**（真相源 `gameplay.js:updateSyncProgress`，落地 `resolveCCBSyncVerdict`）：

| 参战玩家（= 本局尚未结束者） | 判定 | 服务端动作 |
|---|---|---|
| 还有人在本轮没完成 | `waiting` | 只广播 |
| 全员完成 + 本轮已有胜者 | `settle` | 结算 |
| 全员完成 + 还没胜者 | `advance` | `syncRound + 1`、清空完成列表、**重置本轮计时** |
| **归零**（全员 `💀`/`🏳️`） | `settle` | 结算 —— 原版此处 `return` 会永久卡死，见 §5 #8 |

两条容易踩的落地细节（都在 `Server/src/application/CCBService.ts`）：

1. **`syncCompletedPlayerIds` 只有同步模式写**。它同时是「本轮已猜过」的判据，无条件写入会把
   普通/血战模式的连续猜测误判成重复提交（报 `SYNC_ROUND_COMPLETED`）。
2. **两个「参战玩家」口径不同、不能合并成一个函数**：推进只看「本局未结束者」（原版 `isEnded`），
   而开标签透视时要把**已猜对/已出局的人也算进去**（原版 `updateSyncProgress` 的名单不过滤 `isEnded`）。
   服务端因此拆成 `syncParticipants()` 与 `roundParticipantIds()` 两个方法。

### 6.7 设置字段对照（原版 → 本项目）

| 原版 | 本项目 | 说明 |
|---|---|---|
| `metaTags: string[]`（有序，`[0]` 为 primary） | 同名 | 大类与 meta 标签混编；`[0]` 决定作品类型 |
| `maxAttempts` | 同名 | 猜测次数上限，缺省 `10` |
| `timeLimit`（**秒**） | `timeLimitMs`（**毫秒**） | `<= 0` 关闭，否则下限 10 秒 |
| `useHints`（数字数组阈值） | 同名 | 剩余次数 `≤ 阈值` 时显示第 i 条文本提示 |
| `useImageHint`（数字阈值） | 同名 | 模糊半径 = 剩余次数 |
| `characterNum` / `mainCharacterOnly` | 同名 | 从作品里取前 N 个主角/配角 / 只取主角 |
| `commonTags` / `subjectTagNum` / `characterTagNum` | 同名 | 共同标签模式与两类标签数量 |
| `tagBan` / `globalPick` | 同名 | 标签全局 BP / 角色全局 BP |
| `syncMode` + `nonstopMode`（两个布尔） | `mode: "normal" \| "sync" \| "bloodbath"` | 收敛成枚举 |
| `useSubjectPerYear` | 同名 | 按年份均分抽样 |
| `subjectSearch` | 同名 | 允许「先搜作品、再从作品里挑角色」的搜索模式（纯前端行为） |
| `useIndex` / `indexId` / `addedSubjects` | **不移植**（P3 手动出题范围） | 原版的「指定作品集」入口 |

### 6.8 手动出题（P3a 已落地）

**它不是设置项，而是一对指令** —— 原版同样如此（`setAnswerSetter` + `setAnswer`）：

| 步骤 | 指令 | 谁可以发 | 前置 |
|---|---|---|---|
| 1 | `ccb.game.chooseSetter { playerId }` | **房主** | 不在 `guessing`；全员已准备 |
| 2 | `ccb.game.setAnswer { characterId, hint? }` | **被指定的出题人** | `phase === "answering"` |

阶段流转：`waiting` →（chooseSetter）→ `answering` →（setAnswer）→ `guessing`。
开局的实现入口仍是 `CCBService.beginRound`，用一个 `{ manualSetterId }` 参数区分两条路：
不传＝服务端抽题（`answerIsManual: false`，出题人记成房主但不计分），
传了＝手动出题（`answerIsManual: true`，`answerSetterPlayerId` 就是这位真人）。

三条**必须记住**的落地决定：

1. **`setAnswer` 只收 `characterId`**，其余字段由服务端从本地数据集补齐。原版是把客户端加密过的
   整个角色对象丢给服务端，这里换成「只报 id、服务端自己查」，防作弊面更小（§1 服务端权威边界）。
2. **出题人不能猜，但要看得见答案**。答案**不进 `snapshot`** —— 那份快照是全房广播的同一份对象，
   放进去等于把答案发给所有人。改走私有状态：`CCBPrivateState.setterAnswer`（`revealed: false`）。
   好处是刷新页面不丢（原版把答案留在客户端，一刷新就没了）。
3. **三种「出题人卡住」的退出口**，缺一个房间就会永久停在 `answering`（那一步只有一个人能推进）：
   - 出题人被踢 / 掉线 → `clearPendingSetter` 退回 `waiting`（原版 `waitForAnswerCanceled`）；
   - 房主**重新指定**另一个人 → `chooseSetter` 在 `answering` 阶段是合法换人（原版也只拒绝「游戏中」）；
   - 房主点「开始游戏」→ 放弃手动出题、改由服务端抽题（`startRound` 在 `answering` 阶段被允许）。

### 6.9 队伍模式 / 提示系统 / 观战增强（P3b 已落地）

#### 队伍模式

原版 `updatePlayerTeam`：**玩家改自己的队伍**（不是房主分配），`team ∈ '1'..'8'`。

| 规则 | 原版 | 本项目 |
|---|---|---|
| 谁能改 | 自己；UI 只在「未准备且未开局」露出下拉 | 自己；**`phase === "waiting"`** 即可（房主恒为已准备，按原版口径永远组不了队） |
| 观战 | `team === '0'` | **不复用该值** —— 观战是 `membership`，两套真相会打架；`teamOf()` 把残留的 `'0'` 当无队伍 |
| 标记账本 | `currentGame.teamGuesses[team]`，再覆盖回每个队友的 `guesses` | `round.teamMarks[team]`，再覆盖回每个队友的 `marks`（同名同义） |
| 次数上限 | 按队伍串判定 → 任一成员耗尽即全队 `💀` | 同左（共享串天然如此） |
| 猜对 | 猜中者记 `✌`/`👑`；队友记 `🏆`（`teamwin`） | 同左 |
| 队友能否再猜 | 不能（原版置 `_tempObserver`） | 不能 —— 直接置 `finished`。**两者效果一致**（都不能猜、都算「本局已结束」），少一个要到处判的标记位 |
| 队友得分 | 普通/血战 `0`；**同步模式共享胜者分** | 同左：同步模式队友一起进 `solvedPlayerIds`，靠 §6.6 的「共享胜者分」拿到同一份 |
| 投降 | —— | **整队结束本局**。队伍共用一份计数，只结束一个人会立刻产生「共享串里有 `🏳️`、队友还在猜」的矛盾状态 |

#### 提示系统

原版是**纯客户端**行为（`GameInfo.jsx`），本项目把判定搬到服务端（提示文本本来就在服务端）：

- 文本提示由**手动出题的出题人**在 `ccb.game.setAnswer.hints` 里给出，**条数被 `useHints` 的阈值条数截断** ——
  多写的提示永远显示不出来，属于死数据。
- 揭示式照原版：`剩余次数 <= useHints[i]` 时显示第 i 条；`thresholds` 与 `hints` **按序配对**，
  任一侧缺失的位置直接跳过，不会让后面的提示整体错位（纯函数 `resolveCCBRevealedHints`）。
- 剩余次数 = `maxAttempts − player.guessCount`；队伍模式下 `guessCount` 是共享串的计数，正好是原版口径。
- 提示只发给**正式玩家**：出题人与旁观者拿到也没有意义。

> ⚠️ **`useImageHint`（图片提示）不移植**。原版把**答案立绘**发到客户端再按剩余次数做 CSS 模糊 ——
> 在服务端权威模型下，这等于把答案原图发给所有人：所谓「模糊」只是展示层的，任何人打开
> 开发者工具就能拿到未模糊的原图。模糊不是安全边界。要做得安全就得在服务端先做有损降采样，
> 代价与收益不成比例。**登记为已知差异**（与 §5 编号不共用）。

#### 观战增强视图

`CCBPrivateState.spectatedGuesses`：**全部玩家**的猜测明细，只下发给**旁观者与出题人**
（参赛玩家看别人的逐字段反馈等于白拿答案线索）。

- 条数上限 `SPECTATED_GUESS_LIMIT = 60`，从最新往回取 —— 私有状态每帧都走，
  长局的猜测记录会线性增长（`maxAttempts` 上限 100 × 16 人）。
- 标签 BP 的遮掩照旧生效：观战者不是揭示者，所以被 `tagBan` 禁掉的标签对他仍是 `???`。
- 前端据此把「自己那一列」换成「按玩家分组的全场明细」（自己那一列对观战者没有意义）。

### 6.10 角色使用率上报（旁路统计）

原版有两个统计端点，契约相同（`POST /api/{answer,guess}-character-count`，
body `{ characterId, characterName }`）—— 原版的 `/api/character-usage/:id` 与角色排行榜读的就是这两张表。

本项目把**增强版玩家**的对局也报进去（统计的是角色而不是房间，所以纯增强版房间同样上报）：

| 位置 | 行为 |
|---|---|
| `infrastructure/CCBOriginalReporter.ts` | 端点映射与 `fetch`；**任何失败只记日志、绝不抛出** |
| `application/CCBService.ts` | 只声明 `CCBStatsReporter` 接口并注入；`beginRound` 报一次 `answer`，每次**被接受**的猜测报一次 `guess` |
| `transport/App.ts` | 用环境变量 `CCB_ORIGINAL_SERVER_URL` 装配 `CCBOriginalReporter` |

三条约束：

1. **服务器地址一律不进仓库**（用户明确要求）：未配置即空串，`CCBOriginalReporter` 整体停用、
   不白发请求 —— 本地与 CI 都没有出站依赖。
2. **纯旁路**：`reportUsage` 用 `void … .catch(() => undefined)` 兜住，实现方内部再吞一层；
   上报挂掉绝不影响房间状态与结算（有用例钉住）。
3. **被拒的猜测不上报**：上报发生在构造 `record` 之后，早退路径（重复角色、非猜测阶段等）不计。

**默认设置必须对齐原版 `client/src/data/presets.js` 的 `createBasePreset()`**（`DEFAULT_CCB_SETTINGS`）。
三处最容易照直觉写错的地方，都已写成注释钉在契约里：

| 字段 | 原版默认 | 常见误写 | 后果 |
|---|---|---|---|
| `metaTags` | `["", "", ""]` | `["动画"]` | 空串被过滤＝**不加 meta 过滤**，primary 为空走默认分支得到 `type=[2]`，即「全部动画」；写成 `["动画"]` 会把题库收窄到 meta_tags 含「动画」的 **1,428 部**（实测） |
| `commonTags` | `true` | `false` | 默认房间走的是共同标签模式，标签池由 `raw_tags` 驱动 |
| `timeLimitMs` | `0`（不限时） | `60_000` | 原版 `timeLimit` 在基础预设里根本没有字段，含义就是「留空即关闭」 |

其余默认值：`startYear = 今年 − 10`、`endYear = 今年`、`topNSubjects = 50`、`characterNum = 6`、
`mainCharacterOnly = true`、`characterTagNum = 4`、`subjectTagNum = 3`、`maxAttempts = 10`。

⚠️ **两处「大类 → 作品类型」的规则不同，不要合并**：
`getCharacterAppearances` 用 `includes` + else-if 链（顺序：游戏 → 书籍 → 三次元 → 全部 → 默认 `[2]`，
**没有 Galgame 分支**，因此只选 Galgame 时登场作品会先按动画过滤、为空再回退全部）；
`getRandomCharacter.buildFilter` 只看 `metaTags[0]`（primary），且 `Galgame` 会把 meta 过滤项
**替换**成 `['Galgame']`。两者在 `CCBRules.ts` 里各有对应函数，字段含义见该文件注释。

**出题是两级采样**（`getRandomCharacter`）：先按 `type` + 年份区间 + meta 过滤项（`sort: heat`，
取前 `min(topNSubjects, 1000)`）抽一部作品，再从该作品的角色里取 `主角/配角`（`mainCharacterOnly`
时只取主角，否则 `.slice(0, characterNum)`）随机选一个。本地以 `subjects.heat`
（`favorite` 五桶求和）近似线上 `sort: heat` 的排序口径。

## 7. 客户端落地

与另两个游戏同构，逐层对齐（严禁跨游戏目录导入，通用件只在 `components/common/`）：

| 层 | 文件 |
|---|---|
| WS 客户端 | `Client/src/lib/CCBWs.ts`（`createWebSocketClient("/api/ccb/ws")`） |
| 会话持久化 | `Client/src/lib/Storage.ts` 的 `ccb_session_<roomId>` 一族（sessionStorage） |
| 状态 | `Client/src/stores/UseCCBStore.ts`（`connected/rooms/roomId/sessionToken/snapshot/privateState/roomClosedAt/notice`，`initCCBWs` 内部挂事件与状态监听） |
| Provider | `Client/src/contexts/CCBContext.tsx`（只负责 `initCCBWs` 的挂载与卸载，不提供 context value） |
| 布局 | `Client/src/layouts/CCBLayout.tsx`（Provider + Suspense + Outlet + `CCBToastContainer`） |
| 路由 | `/ccb`（大厅）、`/ccb/room/:roomId`（房间）、`/ccb/*` 兜底回大厅 |
| 页面 | `Client/src/pages/CCBPage.tsx`（大厅）、`Client/src/pages/CCBRoomPage.tsx`（三段式房间 + 三栏 + 移动端抽屉） |
| 游戏组件 | `Client/src/components/ccb/`：`PlayerList.tsx`（含自选队伍的下拉）、`GameArea.tsx`（按阶段分派的操作区 + `CCBSetterPicker` + 提示区 + 观战明细）、`GuessTable.tsx`（猜测表）、`CharacterSearch.tsx`（角色搜索）、`SetterPanel.tsx`（手动出题：两步选答案 + 填提示） |
| 反馈映射 | `Client/src/lib/CCBFeedback.ts`（档位→视觉档、档位→箭头；纯函数，表驱动用例在 `CCBFeedback.test.ts`） |
| 模式进度 | 取自 `snapshot.syncProgress` / `snapshot.nonstopWinnerIds`；`GameArea` 顶栏显示「第 N 轮 · X 人未完成」与「已猜对 X 人 · 剩 Y 人」 |

SEO 登记点是四处，缺一不可：`App.tsx` 路由、`data/PageMeta.ts` 的 `PAGE_META`（否则 `Seo` 抛错）、
`pages/LandingPage.tsx` 的卡片 `available/path`、`public/sitemap.xml`。

**能力位一律读 `privateState`，前端不自己推算「能不能猜」**——那是服务端的权威判断
（`canGuess` / `canSurrender` / `canStartRound`），前端据此决定渲染哪些按钮。同理，`GameArea` 的
数据全部取自 store，页面只负责房间外壳（顶栏 / 玩家栏 / 聊天栏）。

**反馈高亮的三个反直觉点**（`lib/CCBFeedback.test.ts` 用表驱动钉住）：

1. **只有 `=` / 单档 `+`·`-` / `?` 三档有底色**，`++` / `--` 反而与普通值一样是中性 —— 原版的
   三元表达式把双符号落在了空串分支，看着像漏写但必须照抄。
2. **箭头与数值高低相反**：`+*` → `↓`、`-*` → `↑`。
3. **性别只有 `yes` 高亮**，`no` 是中性（原版同理）。

⚠️ `CharacterSearch` 里**所有 `setState` 都放在防抖回调里**（异步），effect 体内不同步 setState ——
`react-hooks/set-state-in-effect` 会直接报错并放弃优化整个组件。列表的「展开」也由
`查询词是否等于已取回结果的查询词` 派生，不额外存一个 `open` 状态。

## 8. 阶段落点

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 数据地基、契约、协议与传输、房间服务、房间生命周期测试、前端大厅与三栏房间骨架、角色派生字段输入物化 | ✅ 已完成 |
| P1a | `domain/CCBRules.ts`（标记/反馈/计分/设置派生，纯函数 + 表驱动测试）+ 设置契约按原版重写 | ✅ 已完成 |
| P1b-1 | `infrastructure/CCBCharacterRepository.ts`（两级采样 + 反馈视图 + 检索）与真实数据冒烟 | ✅ 已完成 |
| P1b-2 | 服务端出题与猜测闭环、权威计时、结算广播、`shared/CCB.ts` 补齐 `ccb.game.*` Schema | ✅ 已完成 |
| P1c | 前端搜索栏与猜测表（绿/黄高亮 + ↑↓）、操作区、结算面板 | ✅ 已完成 |
| P2a | 角色全局 BP（`globalPick`）、标签全局 BP（`tagBan`，含「谁先揭示归谁」与同步全员透视） | ✅ 已完成 |
| P2b | 同步模式（按轮推进 / 每轮一次 / 超时视为本轮完成）、血战模式（名次分当场结算、打到全员结束） | ✅ 已完成 |
| P3a | 手动出题（`chooseSetter` + `setAnswer`、出题人计分、三条「卡住」退出口）与前端出题面板 | ✅ 已完成 |
| P3b | 队伍模式（自选队伍 + 共享标记/次数 + 队友 `🏆`）、提示系统（文本提示按阈值解锁）、观战增强视图（全场猜测明细） | ✅ 已完成 |
| P4 | 兼容原版房间（服务端桥接） | 待办，方案见 `tasks/ccb-enhanced-multiplayer-migration-plan.md §5` |

对局类指令（`ccb.character.search` 与 `ccb.game.*`）的 wire 格式已在 `shared/CCB.ts` 固化，
但 **P1 才挂载 Schema**；在此之前发送会得到 `UNKNOWN_MESSAGE_TYPE`，这是有意为之——
宁可明确报错，也不向客户端宣称尚不可用的能力（`CCBPrivateState` 里 `canGuess` / `canStartRound`
等能力位在 P0 一律为 `false`）。
