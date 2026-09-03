# 谁是卧底业务架构与状态机指南 (WhoIsFaker Domain Architecture & State Machine)

本文档是 `WhoIsFaker`（谁是卧底）游戏核心领域模型、网络通信协议、服务端分层、客户端状态流向与游戏规则状态机的权威技术规范。

---

## 1. 通信协议模型 (Communication Protocol)

所有 WebSocket 实时通信统一采用 `Server/src/shared/Protocol.ts` 定义的强类型封包信封（Envelope）：

### 1.1 客户端至服务端 (Client -> Server)
```typescript
interface ClientEnvelope<TPayload = unknown> {
  id: string;              // 客户端生成的唯一消息 UUID（用于 Promise Ack 关联）
  type: string;            // 消息类型，如 "room.join", "game.submitWords"
  roomId?: string;         // 目标房间号（大厅类消息可省略）
  sessionToken?: string;   // 玩家会话 Token
  payload: TPayload;       // 强类型参数载荷
}
```

### 1.2 服务端至客户端 (Server -> Client)
服务端推送固定为以下三种信封结构之一：
- **AckPacket（命令响应）**: `{ type: "ack", id, requestType, payload }`，对应特定命令成功执行。
- **ErrorPacket（错误响应）**: `{ type: "error", id, error: { code, message, details } }`，对应命令执行失败或参数非法。
- **EventPacket（事件广播）**: `{ type: "event", event, payload }`，如 `room.snapshot`, `game.privateState` 等全房或私有广播。

客户端 WebSocket 单例（`Client/src/lib/WhoIsFakerWs.ts`）通过内存 `Map<string, PendingRequest>` 维护消息映射，在接收到对应 `id` 的 Ack 或 Error 时精准 `resolve` / `reject` 前端 Promise。

---

## 2. 系统分层架构 (System Architecture)

### 2.1 服务端分层 (`Server/src/`)
```text
transport/       ← Elysia HTTP/WS 路由、封包解析 (Protocol.ts)、RFC 6902 差量同步 (StateSync.ts)
application/     ← RoomService 房间服务、命令处理器 (handlers/)、ConnectionRegistry 连接注册表
domain/          ← Rules.ts (无副作用纯函数)、Model.ts (领域类型 re-export)、Errors.ts (统一错误定义)
infrastructure/  ← WordBankRepository (持久化词库)、EventLogger (日志记录)
config/          ← Env.ts, Constants.ts
```

- **纯内存状态机**：所有房间数据和游戏对局状态纯内存存储，无外部数据库依赖。
- **孤儿房间清理**：`runHousekeeping()` 以 10 秒为周期自动检测清理无人在线的过期空房间（测试房间除外）。

### 2.2 客户端状态与路由 (`Client/src/`)
- **状态 Store**：`useWhoIsFakerStore`（`Client/src/stores/UseWhoIsFakerStore.ts`）持有房间快照与私有状态。
- **生命周期连接器**：`WhoIsFakerContext.tsx`。
- **前端路由 (React Router v7)**：
  - `/` → `LandingPage`（多游戏门户主页）
  - `/whoisfaker` → `WhoIsFakerPage`（大厅）
  - `/whoisfaker/room/:roomId` → `WhoIsFakerRoomPage`（游戏房间）

---

## 3. 核心设计模式 (Core Design Patterns)

### 3.1 双快照模型 (Dual Snapshot Model)
服务端每次状态下发严格拆分为两个独立的通道：
1. **公共快照 (`room.snapshot`)**：房间内全员相同且公开的数据（玩家列表、当前游戏阶段、公开词语提示、发言历史、投票列表等）。
2. **私有状态 (`game.privateState`)**：特定连接专属的私密数据（本人真实词语、天使可选词对、白板词性提示、出题人底牌全词、本人真实选票等）。

**铁律**：严禁在前端从公共快照推断任何私有信息；私有信息必须且仅能来自 `game.privateState`。

### 3.2 强类型业务错误 (Typed Errors)
统一抛出带有业务错误码（`code`）的 `AppError`（如 `"ROOM_NOT_FOUND"`, `"INVALID_PHASE"`, `"NOT_QUESTIONER"`），传输层自动拦截并打包为 `ErrorPacket`。

### 3.3 标签页会话隔离与重连 (Session Persistence)
- 玩家的 `sessionToken` 统一按 `roomId` 隔离存储于当前标签页的 `sessionStorage`；仅玩家昵称保留在 `localStorage`。
- 刷新同一标签页可自动调用 `room.reconnect` 恢复会话；打开新标签页默认作为独立访客进入。

### 3.4 掉线按需暂停机制 (Disconnects Pause on Demand)
- 玩家掉线不会盲目阻断整个房间。`shouldQueueDisconnectForDecision` 按当前阶段判断掉线玩家是否**正在阻塞流程**（如尚未提交发言、尚未投票、夜间行动未执行、处于猜词中的白板）。
- 已完成本轮动作的玩家掉线直接忽略，不暂停倒计时。
- 阶段跨越时，`requeuePendingDisconnects` 会重新核算离线玩家是否阻塞新阶段，并在需要时重新向房主发起决策请求广播 `game.disconnectDecisionRequested`。
- 出题人掉线不受普通决策队列影响，走专用的重连宽限期倒计时。

### 3.5 测试房间空房保护 (Test Room Immunity)
- 房间号为 `"Oblivionis"`（大小写不敏感）的测试房间，严禁因“全员离线”而被自动回收。
- `shouldAutoCloseWhenEmpty` 必须在全量 3 处清理切面（`runHousekeeping` 及两处 `handlePlayerOffline` 分支）严格豁免测试房。

---

## 4. 游戏规则与状态机 (Game State Machine)

### 4.1 阶段生命周期图
```text
waiting → assigningQuestioner → wordSubmission → description → voting
  → tieBreak (若最高票平票) → night → description (次日天亮，循环)
  → blankGuess (若触发白板猜词，全局阻塞)
  → gameOver (结算归档)
```

### 4.2 角色池与人数要求
- **开局条件**：至少 4 名参战玩家 + 1 名出题人（出题人可由房主指定或由房主本人/旁观者担任）。
- **卧底人数公式**：`maxUndercoverCount = max(1, Math.ceil(participantCount / 4))`。
- **可选高级角色**：
  - **白板 (`blank`)**：无词语，仅有词性提示；房间达到 8 人及以上可用。
  - **天使 (`angel`)**：持有双词，首夜可选阵营并拥有一次性护盾；房间达到 10 人及以上可用。

### 4.3 胜负判定条件
- **好人胜 (`good`)**：所有卧底被投票放逐出局。
- **卧底胜 (`undercover`)**：存活卧底人数大于等于存活平民人数。
- **白板胜 (`blank`)**：白板玩家在猜词阶段正确猜中平民词与卧底词。
- **流局 (`aborted`)**：出题人被踢出、重连超时或房主主动解散。

---

## 5. 发言与补充发言记录机制 (Description Records)

### 5.1 记录模型分类
发言记录 `DescriptionRecord.kind` 严格分为三类：
- `"description"`：常规轮次发言。
- `"tieBreak"`：平票 PK 轮次发言，包含 `tieBreakIndex: 1, 2, 3...`。
- `"supplement"`：出题人发起的额外补充发言，包含 `supplementIndex: 1, 2, 3...`。

`GameRound.speechMode` 与 `RoomSnapshot.status.speechMode` 取值为 `"normal" | "supplement" | "tieBreak"`，用于驱动前端差异化展示发言列，无需额外引入破坏性的顶级游戏阶段。

### 5.2 补充发言交互流程 (`game.requestSupplement`)
- **触发时机**：常规发言完毕（`isDescriptionComplete`）后至投票结算前，出题人可指定任意 1~N 名玩家进行补充发言。
- **状态切换**：房间切入 `description + supplement` 模式，全房客户端离开投票视图回到发言视图。
- **投票保护**：已经投出的选票完整保留，但在此期间禁止新投票、禁止撤销投票、禁止阶段强制推进。
- **自动恢复**：待所有被点名玩家完成补充发言后，服务端自动清除补充态并无缝切回 `resumePhase`（通常为 `voting`）。

---

## 6. 白板猜词机制 (Blank Player UX & Adjudication)

白板猜词是游戏的**全局阻塞阶段**，整房暂停一切倒计时并切换为全员围观：

1. **触发入口 (`BlankGuessButton`)**：白板玩家在存活期间（或残局触发）可见，点击弹窗二次确认后发送 `game.enterBlankGuess`。每局有且仅有 1 次尝试机会。
2. **倒计时打断与暂存还原 (`interruptedRemainingTimerMs`)**：白板发起猜词打断发言阶段时，服务端计算并暂存当前阶段剩余毫秒数。若后续裁定未通过或超时切回原阶段，系统精准恢复该剩余倒计时，杜绝倒计时丢失或被重置为初始全长。
3. **实时草稿广播 (`blankGuessDraft`)**：白板输入时，前端以约 220ms 节流发送 `game.updateBlankGuessDraft`，服务端实时广播草稿给全房玩家围观其推演过程。
4. **掉线兜底防死锁**：若白板在猜词阻塞期间意外断线，出题人选择“继续等待”时，服务端强制挂载 60 秒倒计时兜底；若到期白板未重连提交，超时机制自动判定猜词失败并切回原阶段，杜绝房间陷入不可推进的死锁。
5. **出题人复核裁定 (`pendingReview`)**：
   - 真实词对仅通过 `privateState.globalWords` 下发出题人，公共快照严格保密。
   - 为避免因错别字或同义词（如“香焦”与“香蕉”）误杀，若自动精确比对未完全匹配，服务端**不直接宣告失败**，而是挂起至 `pendingReview` 阻塞等待出题人人工裁定。
   - 出题人通过 `game.reviewBlankGuess` 提交 `{ approve: boolean }`：
     - `approve: true`：改判为猜中，直接宣告白板获胜，对局结束。
     - `approve: false`：维持猜错，机会耗尽；若为残局触发则按残局胜负结算，否则退回原阶段继续游戏。

---

## 7. 选票撤销与弃权规则 (Voting & Cancel Vote)

- **投票真相源**：`privateState.myCurrentVoteTargetId` 是当前玩家已投票目标的唯一受信任来源。严禁在 React 组件内部私自缓存选票。
- **选票撤销**：在投票或平票阶段，投票者可随时调用 `game.cancelVote` 清除己方选票并重新选择。
- **弃权票机制**：投给 `ABSTAIN_TARGET_ID`（`"abstain"`）视为有效提交的选票（计入“全员已投票”推进条件），但不计入任何玩家被投得票数；若弃权票达到最高票，直接进入平票 PK。

---

## 8. 玩家标记与房主权限 (Player Marking & Host Actions)

- **纯前端本地标记**：非出题人的存活玩家可在界面上为其他玩家打上身份标记（`"unknown" | PlayerRole`），该数据仅保存在 React 组件本地状态，不持久化、不上报服务端，刷新即重置。出题人与旁观者直接展示服务端下发的真实身份。
- **房主权限**：房主可在对局任意阶段踢出掉线玩家或转让房主。踢出当前对局出题人将立即导致对局流局终止。

---

## 9. 专用测试模式 (Test Mode - "Oblivionis")

- 房间号为 `"Oblivionis"` 时自动启用测试模式。
- 允许客户端 `TestController` 发送调试指令：
  - `test.jumpToPhase`：强制跳转到任意指定阶段。
  - `test.setMyRole`：实时修改自身角色。
  - `test.addBot` / `test.removeBot`：动态增减全功能服务端仿真机器人（占用阵营席位、自动发言、参与投票）。
