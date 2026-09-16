// ==================== CCB（二刺猿笑传之猜猜呗 · 增强版）契约 ====================
// 只依赖 Model.ts / Protocol.ts，严禁 import 另两个游戏的契约。
//
// 分工：本文件定义**房间生命周期 / 大厅 / 玩家视图 / 传输消息**；
// 反馈判定与计分的具体语义由 `domain/CCBRules.ts` 承载（P1 落地，需对着原版
// `anime-character-guessr/client/src/utils/bangumi.js` 的 `generateFeedback` 逐字段复刻，
// 并用 `CCBFilter/data/data.json` 对拍）。因此这里只保留承载它们的**容器字段**，
// 不预先编码标记/等级的取值语义——写错的契约比没有契约更糟。
//
// 分阶段落点：本文件是**目标形态**，不代表当前已挂载。各字段的落点阶段在注释中标注。

import type { ChatMessage, PlayerMembership, RoomVisibility } from "./Model";
import type { ClientEnvelope } from "./Protocol";

/**
 * 房间/对局阶段。
 *
 * 原版没有显式 phase，靠 `currentGame` / `waitingForAnswer` / `answerSetterId` 组合推导；
 * 本实现按本项目规范收敛成显式枚举与迁移表（见 `Agents/CCB.md`）。
 */
export const CCB_PHASES = ["waiting", "answering", "guessing", "settled"] as const;
export type CCBPhase = (typeof CCB_PHASES)[number];

/**
 * 对局模式。
 * - `normal`：先猜对者结束本局，其余玩家继续到次数耗尽。
 * - `sync`：全员完成本轮才推进轮次，胜者等本轮结束后统一结算。
 * - `bloodbath`：淘汰制，按名次给分（`max(1, 参战人数 − 已胜人数)`），直至全员结束。
 */
export const CCB_GAME_MODES = ["normal", "sync", "bloodbath"] as const;
export type CCBGameMode = (typeof CCB_GAME_MODES)[number];

/** 角色性别口径：非男非女一律 `?`（与构建期归一化、原版反馈判定同一口径）。 */
export type CCBGender = "male" | "female" | "?";

/** 作品类型（Bangumi `subject.type`）：1 书籍 / 2 动画 / 4 游戏 / 6 三次元。 */
export const CCB_SUBJECT_TYPES = [1, 2, 4, 6] as const;
export type CCBSubjectType = (typeof CCB_SUBJECT_TYPES)[number];

/** 单条自定义短消息长度上限（玩家点自己名字编辑）。 */
export const CCB_PLAYER_MESSAGE_LIMIT = 32;

/** 角色搜索结果：字段全部来自本地只读数据集，图片由回填缓存补充。落点 P1。 */
export interface CCBCharacterSearchResult {
  id: number;
  /** 原名（多为日文）。 */
  name: string;
  /** 简体中文名；本地缺失时回落到 `name`。 */
  nameCn: string;
  gender: CCBGender;
  /** 热度＝`collects + comments`。 */
  popularity: number;
  imageUrl?: string;
}

/** 角色标签（来自 `character_tags` 表的上游 `id_tags` 快照）。落点 P1。 */
export interface CCBCharacterTags {
  id: number;
  tags: string[];
}

export interface CCBGameSettings {
  mode: CCBGameMode;
  /** 题库范围：按热度取前 N 部动画；0 表示不限。 */
  topNSubjects: number;
  startYear?: number;
  endYear?: number;
  subjectTypes: CCBSubjectType[];
  /** 每位玩家的猜测次数上限。 */
  guessLimit: number;
  /** 单局时限（毫秒）；0 表示不限时。 */
  timeLimitMs: number;
  /** 文本提示（来自角色简介）。 */
  textHint: boolean;
  /** 模糊图提示：按剩余次数递减模糊半径。 */
  blurHint: boolean;
  /** 标签全局 BP：暴露共享标签的人，其他人看到 `???`。落点 P2。 */
  tagBan: boolean;
  /** 角色全局 BP：同一角色不可被重复猜。落点 P2。 */
  globalPick: boolean;
}

export const DEFAULT_CCB_SETTINGS: CCBGameSettings = {
  mode: "normal",
  topNSubjects: 500,
  subjectTypes: [2],
  guessLimit: 10,
  timeLimitMs: 0,
  textHint: true,
  blurHint: true,
  tagBan: false,
  globalPick: false,
};

/**
 * 玩家公共视图。
 *
 * `marks` 是原版「标记串」的直译：尝试类标记与结束类标记按发生顺序拼接。
 * 各字符的确切语义由 `CCBRules.ts` 定义（P1），这里只保证它是一个可展示的字符串。
 */
export interface CCBPlayerView {
  id: string;
  name: string;
  score: number;
  membership: PlayerMembership;
  nextRoundMembership?: "active" | "spectator";
  online: boolean;
  isReady: boolean;
  isBot: boolean;
  /** 由 `hostPlayerId` 派生，不是独立状态。 */
  isHost: boolean;
  /** 自定义短消息（玩家点自己名字编辑）。 */
  message: string;
  /** 本局标记串。 */
  marks: string;
  /** 本局已用猜测次数。 */
  guessCount: number;
  /** 本局是否已完成（同步模式与血战模式据此推进）。 */
  finished: boolean;
  /** 队伍：`null`＝无队伍，`'0'`＝观战，`'1'..'8'`＝队伍号（P3 启用）。 */
  team: string | null;
}

export interface CCBRoomSummary {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  playerCount: number;
  spectatorCount: number;
  onlineCount: number;
  phase: CCBPhase;
}

/** 答案卡在 `settled` 之外只对出题人与观战者可见；增强版一律由服务端权威出题。落点 P1。 */
export interface CCBAnswerView {
  id: number;
  name: string;
  nameCn: string;
  imageUrl?: string;
  /** 是否允许非出题人查看（对局结束后公开）。 */
  revealed: boolean;
}

export interface CCBRoomSnapshot {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  hostPlayerId: string;
  testMode: boolean;
  settings: CCBGameSettings;
  phase: CCBPhase;
  /** 本局序号（从 1 开始，跨局累计）。 */
  roundNumber: number;
  /** 出题人：服务端出题的房间里指向被指定的房主；手动出题模式下是被指定的玩家。落点 P1/P3。 */
  answerSetterPlayerId?: string;
  /** 本局截止时间；未限时则为空。落点 P1。 */
  guessDeadlineAt?: number;
  players: CCBPlayerView[];
  chat: ChatMessage[];
  /** 仅在对局结束（`settled`）或允许观战时下发。落点 P1。 */
  answer?: CCBAnswerView;
  /** 被全局 BP 屏蔽的标签（`tagBan` 生效时会以 `???` 展示）。落点 P2。 */
  bannedTags?: string[];
}

export interface CCBPrivateState {
  playerId: string;
  sessionToken: string;
  /** 出题人可设答案（手动出题模式）。落点 P3。 */
  canSetAnswer: boolean;
  /** 当前是否可提交猜测。落点 P1。 */
  canGuess: boolean;
  canSurrender: boolean;
  canStartRound: boolean;
  /** 剩余猜测次数。 */
  remainingGuesses: number;
  /** 只有自己可见的猜测记录（含逐字段反馈）。落点 P1。 */
  ownGuesses: CCBGuessRecord[];
  /** 已用过的文本提示。落点 P3。 */
  hints: string[];
}

/**
 * 一次猜测的记录。落点 P1。
 *
 * `feedback` 为未知结构（`unknown`）：逐字段的等级/箭头取值随 `CCBRules.ts` 在 P1 定稿，
 * 现在写死类型只会制造返工。服务端与客户端通过同一份 `CCBRules` 解释它。
 */
export interface CCBGuessRecord {
  characterId: number;
  characterName: string;
  characterNameCn: string;
  imageUrl?: string;
  submittedAt: number;
  correct: boolean;
  feedback: unknown;
}

// ==================== 服务端内部记录（跨层传递，故与另两个游戏一致放在 shared） ====================

export interface CCBPlayerRecord {
  id: string;
  name: string;
  sessionToken: string;
  membership: PlayerMembership;
  nextRoundMembership?: "active" | "spectator";
  online: boolean;
  isReady: boolean;
  isBot: boolean;
  score: number;
  /** 自定义短消息（玩家点自己名字编辑）。 */
  message: string;
  /** 本局标记串（由 `CCBRules` 拼接与去重）。 */
  marks: string;
  /** 本局已用猜测次数。 */
  guessCount: number;
  /** 本局是否已完成（同步模式与血战模式据此推进）。 */
  finished: boolean;
  /** 队伍：`null`＝无队伍，`'0'`＝观战，`'1'..'8'`＝队伍号（P3 启用）。 */
  team: string | null;
  /** 同步模式下已完成到第几轮（P2）。 */
  syncCompletedRound?: number;
  joinedAt: number;
  lastSeenAt: number;
  connectionId?: string;
}

/** 落点 P1。 */
export interface CCBRoundRecord {
  roundNumber: number;
  answerCharacterId: number;
  answerSetterPlayerId: string;
  startedAt: number;
  deadlineAt?: number;
  /** 已提交的猜测，按玩家分组。 */
  guesses: Record<string, CCBGuessRecord[]>;
  /** 已猜对的玩家。 */
  solvedPlayerIds: string[];
  /** 被全局 BP 屏蔽的标签。 */
  bannedTags: string[];
}

/**
 * 房间记录。
 *
 * 与 `SonGuessrRoomRecord` 保持结构对称：`players` 用 id 索引便于 O(1) 查找；
 * `isHost` / `testMode` 一律由 `hostPlayerId` 与房间号派生，不存第二份真相。
 */
export interface CCBRoomRecord {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  /** 仅私密房间有值；只在内存中做等值比较，不落库、不进日志。 */
  password?: string;
  allowSpectators: boolean;
  hostPlayerId: string;
  settings: CCBGameSettings;
  phase: CCBPhase;
  roundNumber: number;
  players: Record<string, CCBPlayerRecord>;
  chat: ChatMessage[];
  currentRound?: CCBRoundRecord;
  answerSetterPlayerId?: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  /** 全员离线的起点，用于空房宽限期。 */
  emptySinceAt?: number;
  /** 房主断线后的宽限截止时间，超时即转移房主。 */
  hostReconnectDeadlineAt?: number;
}

// ==================== 客户端消息 ====================

export type CCBClientEnvelope<TType extends string, TPayload> = ClientEnvelope<TType, TPayload>;

export type CCBClientMessage =
  | ClientEnvelope<"ccb.lobby.subscribeRooms", Record<string, never>>
  | ClientEnvelope<
      "ccb.room.create",
      {
        roomId: string;
        name: string;
        visibility: RoomVisibility;
        password?: string;
        allowSpectators: boolean;
        userName: string;
        settings?: Partial<CCBGameSettings>;
      }
    >
  | ClientEnvelope<"ccb.room.join", { userName: string; password?: string }>
  | ClientEnvelope<"ccb.room.reconnect", { roomId: string; sessionToken: string }>
  | ClientEnvelope<"ccb.room.leave", Record<string, never>>
  | ClientEnvelope<"ccb.room.requestSync", Record<string, never>>
  | ClientEnvelope<
      "ccb.room.updateSettings",
      Partial<CCBGameSettings> & {
        name?: string;
        visibility?: RoomVisibility;
        password?: string;
        allowSpectators?: boolean;
      }
    >
  | ClientEnvelope<"ccb.room.kick", { playerId: string }>
  | ClientEnvelope<"ccb.room.transferHost", { playerId: string }>
  | ClientEnvelope<"ccb.player.setReady", { ready: boolean }>
  | ClientEnvelope<"ccb.player.setSpectator", { spectator: boolean }>
  | ClientEnvelope<"ccb.player.setMessage", { message: string }>
  | ClientEnvelope<"ccb.chat.send", { text: string }>
  | ClientEnvelope<"ccb.test.addBot", { count?: number }>
  | ClientEnvelope<"ccb.test.removeBot", { count?: number }>
  | ClientEnvelope<"ccb.character.search", { keyword: string }>
  | ClientEnvelope<"ccb.game.start", Record<string, never>>
  | ClientEnvelope<"ccb.game.chooseSetter", { playerId: string }>
  | ClientEnvelope<"ccb.game.setAnswer", { characterId: number; hint?: string }>
  | ClientEnvelope<"ccb.game.guess", { characterId: number }>
  | ClientEnvelope<"ccb.game.surrender", Record<string, never>>
  | ClientEnvelope<"ccb.game.nextRound", Record<string, never>>
  | ClientEnvelope<"ccb.game.finish", Record<string, never>>;

/**
 * 服务端下发的事件名。
 *
 * `roomSnapshot` / `privateState` 必须同步登记进 `transport/StateSync.ts` 的 `STATE_EVENTS`，
 * 否则每次变化都会退化成全量推送，违反 `Spec.md §7` 的 6 Mbps 预算。
 */
export const CCB_STATE_EVENTS = {
  roomSnapshot: "ccb.room.snapshot",
  privateState: "ccb.game.privateState",
  lobbyRooms: "ccb.lobby.rooms",
  roomClosed: "ccb.room.closed",
  roomKicked: "ccb.room.kicked",
} as const;
