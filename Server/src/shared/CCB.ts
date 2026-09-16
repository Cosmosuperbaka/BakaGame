// ==================== CCB（二刺猿笑传之猜猜呗 · 增强版）契约 ====================
// 只依赖 Model.ts / Protocol.ts，严禁 import 另两个游戏的契约。
//
// 分工：本文件定义**房间生命周期 / 大厅 / 玩家视图 / 传输消息**；
// 反馈判定与计分的具体语义由 `domain/CCBRules.ts` 承载（P1 落地，需对着原版
// `anime-character-guessr/client/src/utils/bangumi.js` 的 `generateFeedback` 逐字段移植，
// 并用 `CCBFilter/data/data.json` 对拍）。因此这里只保留承载它们的**容器字段**，
// 不预先编码标记/等级的取值语义——写错的契约比没有契约更糟。

import type { ChatMessage, PlayerMembership, RoomVisibility } from "./Model";
import type { ClientEnvelope } from "./Protocol";

/**
 * 房间/对局阶段。
 *
 * 原版没有显式 phase，靠 `currentGame` / `waitingForAnswer` / `answerSetterId` 组合推导；
 * 本实现按本项目规范收敛成显式枚举与迁移表（见 `Agents/CCB.md`）。
 */
export const CCB_PHASES = ["waiting", "answering", "guessing", "settled"] as const;
export type CcbPhase = (typeof CCB_PHASES)[number];

/**
 * 对局模式。
 * - `normal`：先猜对者结束本局，其余玩家继续到次数耗尽。
 * - `sync`：全员完成本轮才推进轮次，胜者等本轮结束后统一结算。
 * - `bloodbath`：淘汰制，按名次给分（`max(1, 参战人数 − 已胜人数)`），直至全员结束。
 */
export const CCB_GAME_MODES = ["normal", "sync", "bloodbath"] as const;
export type CcbGameMode = (typeof CCB_GAME_MODES)[number];

/** 角色性别口径：非男非女一律 `?`（与构建期归一化、原版反馈判定同一口径）。 */
export type CcbGender = "male" | "female" | "?";

/** 作品类型（Bangumi `subject.type`）：1 书籍 / 2 动画 / 4 游戏 / 6 三次元。 */
export const CCB_SUBJECT_TYPES = [1, 2, 4, 6] as const;
export type CcbSubjectType = (typeof CCB_SUBJECT_TYPES)[number];

/** 聊天常量与另两个游戏保持一致（只走状态通道）。 */
export const CCB_CHAT_LIMIT = 20;

/** 角色搜索结果：字段全部来自本地只读数据集，图片由回填缓存补充。 */
export interface CcbCharacterSearchResult {
  id: number;
  /** 原名（多为日文）。 */
  name: string;
  /** 简体中文名；本地缺失时回落到 `name`。 */
  nameCn: string;
  gender: CcbGender;
  /** 热度＝`collects + comments`。 */
  popularity: number;
  imageUrl?: string;
}

/** 角色标签（来自 `character_tags` 表的上游 `id_tags` 快照）。 */
export interface CcbCharacterTags {
  id: number;
  tags: string[];
}

export interface CcbGameSettings {
  mode: CcbGameMode;
  /** 题库范围：按热度取前 N 部动画；0 表示不限。 */
  topNSubjects: number;
  startYear?: number;
  endYear?: number;
  subjectTypes: CcbSubjectType[];
  /** 每位玩家的猜测次数上限。 */
  guessLimit: number;
  /** 单局时限（毫秒）；0 表示不限时。 */
  timeLimitMs: number;
  /** 文本提示（来自角色简介）。 */
  textHint: boolean;
  /** 模糊图提示：按剩余次数递减模糊半径。 */
  blurHint: boolean;
  /** 标签全局 BP：暴露共享标签的人，其他人看到 `???`。 */
  tagBan: boolean;
  /** 角色全局 BP：同一角色不可被重复猜。 */
  globalPick: boolean;
}

export const DEFAULT_CCB_SETTINGS: CcbGameSettings = {
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
export interface CcbPlayerView {
  id: string;
  name: string;
  score: number;
  membership: PlayerMembership;
  nextRoundMembership?: "active" | "spectator";
  online: boolean;
  isReady: boolean;
  isBot: boolean;
  isHost: boolean;
  /** 自定义短消息（玩家点自己名字编辑）。 */
  message: string;
  /** 本局标记串。 */
  marks: string;
  /** 本局已用猜测次数。 */
  guessCount: number;
  /** 本局/本轮是否已完成（同步模式与血战模式据此推进）。 */
  finished: boolean;
  /** 队伍：`null`＝无队伍，`'0'`＝观战，`'1'..'8'`＝队伍号（队伍模式 P3 启用）。 */
  team: string | null;
}

export interface CcbRoomSummary {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  playerCount: number;
  spectatorCount: number;
  onlineCount: number;
  phase: CcbPhase;
}

/** 答案卡在 `settled` 之外只对出题人与观战者可见；增强版一律由服务端权威出题。 */
export interface CcbAnswerView {
  id: number;
  name: string;
  nameCn: string;
  imageUrl?: string;
  /** 是否允许非出题人查看（对局结束后公开）。 */
  revealed: boolean;
}

export interface CcbRoomSnapshot {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  hostPlayerId: string;
  testMode: boolean;
  settings: CcbGameSettings;
  phase: CcbPhase;
  /** 本局序号（从 1 开始，跨局累计）。 */
  roundNumber: number;
  /** 出题人：服务端出题的房间里指向被指定的房主；手动出题模式下是被指定的玩家。 */
  answerSetterPlayerId?: string;
  /** 本局截止时间；未限时则为空。 */
  guessDeadlineAt?: number;
  players: CcbPlayerView[];
  chat: ChatMessage[];
  /** 仅在对局结束（`settled`）或允许观战时下发。 */
  answer?: CcbAnswerView;
  /** 被全局 BP 屏蔽的标签（`tagBan` 生效时会以 `???` 展示）。 */
  bannedTags?: string[];
}

export interface CcbPrivateState {
  playerId: string;
  sessionToken: string;
  /** 出题人可设答案（手动出题模式）。 */
  canSetAnswer: boolean;
  /** 当前是否可提交猜测。 */
  canGuess: boolean;
  canSurrender: boolean;
  canStartRound: boolean;
  /** 剩余猜测次数。 */
  remainingGuesses: number;
  /** 只有自己可见的猜测记录（含逐字段反馈）。 */
  ownGuesses: CcbGuessRecord[];
  /** 已用过的文本提示。 */
  hints: string[];
}

/**
 * 一次猜测的记录。
 *
 * `feedback` 为未知结构（`unknown`）：逐字段的等级/箭头取值随 `CCBRules.ts` 在 P1 定稿，
 * 现在写死类型只会制造返工。服务端与客户端通过同一份 `CCBRules` 解释它。
 */
export interface CcbGuessRecord {
  characterId: number;
  characterName: string;
  characterNameCn: string;
  imageUrl?: string;
  submittedAt: number;
  correct: boolean;
  feedback: unknown;
}

// ==================== 服务端内部记录（跨层传递，故与另两个游戏一致放在 shared） ====================

export interface CcbPlayerRecord {
  id: string;
  name: string;
  isHost: boolean;
  score: number;
  ready: boolean;
  /** 本局标记串。 */
  marks: string;
  message: string;
  team: string | null;
  membership: PlayerMembership;
  online: boolean;
  isBot: boolean;
  sessionToken: string;
  /** 本局已用猜测次数。 */
  guessCount: number;
  finished: boolean;
  /** 同步模式下已完成到第几轮。 */
  syncCompletedRound?: number;
}

export interface CcbRoundRecord {
  roundNumber: number;
  answerCharacterId: number;
  answerSetterPlayerId: string;
  startedAt: number;
  deadlineAt?: number;
  /** 已提交的猜测，按玩家分组。 */
  guesses: Record<string, CcbGuessRecord[]>;
  /** 已猜对的玩家。 */
  solvedPlayerIds: string[];
  /** 被全局 BP 屏蔽的标签。 */
  bannedTags: string[];
}

export interface CcbRoomRecord {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  passwordHash?: string;
  allowSpectators: boolean;
  hostPlayerId: string;
  testMode: boolean;
  settings: CcbGameSettings;
  phase: CcbPhase;
  roundNumber: number;
  players: CcbPlayerRecord[];
  chat: ChatMessage[];
  currentRound?: CcbRoundRecord;
  answerSetterPlayerId?: string;
  createdAt: number;
  lastActiveAt: number;
}

// ==================== 客户端消息 ====================

export type CcbClientEnvelope<TType extends string, TPayload> = ClientEnvelope<TType, TPayload>;

export type CcbClientMessage =
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
        settings?: Partial<CcbGameSettings>;
      }
    >
  | ClientEnvelope<"ccb.room.join", { userName: string; password?: string }>
  | ClientEnvelope<"ccb.room.reconnect", { roomId: string; sessionToken: string }>
  | ClientEnvelope<"ccb.room.leave", Record<string, never>>
  | ClientEnvelope<"ccb.room.requestSync", Record<string, never>>
  | ClientEnvelope<
      "ccb.room.updateSettings",
      Partial<CcbGameSettings> & {
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
  | ClientEnvelope<"ccb.character.search", { keyword: string }>
  | ClientEnvelope<"ccb.game.start", Record<string, never>>
  | ClientEnvelope<"ccb.game.chooseSetter", { playerId: string }>
  | ClientEnvelope<"ccb.game.setAnswer", { characterId: number; hint?: string }>
  | ClientEnvelope<"ccb.game.guess", { characterId: number }>
  | ClientEnvelope<"ccb.game.surrender", Record<string, never>>
  | ClientEnvelope<"ccb.game.nextRound", Record<string, never>>
  | ClientEnvelope<"ccb.game.finish", Record<string, never>>
  | ClientEnvelope<"ccb.test.addBot", { count?: number }>
  | ClientEnvelope<"ccb.test.removeBot", { count?: number }>;

/** 服务端下发的事件名（`StateSync.STATE_EVENTS` 必须同步登记，否则退化为每次全量）。 */
export const CCB_STATE_EVENTS = {
  roomSnapshot: "ccb.room.snapshot",
  privateState: "ccb.game.privateState",
  lobbyRooms: "ccb.lobby.rooms",
  roomExpiring: "ccb.room.expiring",
  roomClosed: "ccb.room.closed",
  roomKicked: "ccb.room.kicked",
  characterSearch: "ccb.character.searchResult",
} as const;
