import type { ClientEnvelope } from "./Protocol";
import type {
  ChatMessage,
  PlayerMembership,
  RoomVisibility,
} from "./Model";

// ==================== 谁是卧底 (WhoIsFaker) 领域模型与协议 ====================

// 游戏主状态机的阶段定义。
export const WHOISFAKER_PHASES = [
  "waiting",
  "assigningQuestioner",
  "wordSubmission",
  "description",
  "voting",
  "tieBreak",
  "night",
  "blankGuess",
  "gameOver",
] as const;

export const GAME_PHASES = WHOISFAKER_PHASES;

export type WhoIsFakerPhase = (typeof WHOISFAKER_PHASES)[number];
export type GamePhase = WhoIsFakerPhase;

export const WHOISFAKER_ROLES = [
  "civilian",
  "undercover",
  "angel",
  "blank",
] as const;

export const PLAYER_ROLES = WHOISFAKER_ROLES;

export type WhoIsFakerRole = (typeof WHOISFAKER_ROLES)[number];
export type PlayerRole = WhoIsFakerRole;
export type PlayerSide = "good" | "undercover" | "blank";
export type DescriptionKind = "description" | "tieBreak" | "supplement";
export type SpeechMode = "normal" | "supplement" | "tieBreak";
export type TieBreakStage = "description" | "vote";
export type DisconnectResolution = "wait" | "eliminate";
export type RoundWinner = "good" | "undercover" | "blank" | "aborted";

/** 阶段倒计时运行时状态，严格仅限当前阶段生效。 */
export interface PhaseTimerState {
  /** 倒计时时长（秒）：60 | 120 | 180 */
  durationSeconds: number;
  /** 倒计时结束的绝对毫秒时间戳 */
  endsAt: number;
  /** 倒计时所属的游戏阶段 */
  phase: GamePhase;
  /** 触发时的发言模式（用于区分 normal / supplement / tieBreak） */
  speechMode?: SpeechMode;
  /** 触发时的平票PK阶段（用于区分 description / vote） */
  tieBreakStage?: TieBreakStage;
}

// 房主在开局前配置的阵营参数。
export interface RoleConfig {
  undercoverCount: number;
  hasAngel: boolean;
  hasBlank: boolean;
}

// 根据当前人数动态推导出的阵营上限。
export interface RoleLimits {
  maxUndercoverCount: number;
  canEnableAngel: boolean;
  canEnableBlank: boolean;
}

// 房间基础设置，前端编辑房间时主要围绕这一组字段。
export interface RoomSettings {
  name: string;
  visibility: RoomVisibility;
  password?: string;
  allowSpectators: boolean;
  roleConfig: RoleConfig;
}

export interface WhoIsFakerPlayerRecord {
  id: string;
  sessionToken: string;
  name: string;
  score: number;
  membership: PlayerMembership;
  isReady: boolean;
  isBot: boolean;
  online: boolean;
  joinedAt: number;
  lastSeenAt: number;
  connectionId?: string;
}

export type PlayerRecord = WhoIsFakerPlayerRecord;

// 每条描述都带上阶段类型与轮次，便于结算时回放。
export interface DescriptionRecord {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  kind: DescriptionKind;
  cycle: number;
  /** 平票 PK 轮次编号（kind=tieBreak 时存在），1-based。 */
  tieBreakIndex?: number;
  /** 补充发言轮次编号（kind=supplement 时存在），1-based。 */
  supplementIndex?: number;
  createdAt: number;
}

/**
 * 弃票在 VoteRecord 里占用一个保留的 targetId：
 * 弃票同样是一次已完成的投票，必须计入「谁还没投」的判定，
 * 因此不能用「没有记录」来表示。计票时不计入任何玩家的得票。
 */
export const ABSTAIN_TARGET_ID = "abstain";

// 投票阶段只记录“谁投给了谁”，统计在运行时计算。
export interface VoteRecord {
  voterId: string;
  targetId: string;
}

export interface DaybreakNotice {
  day: number;
  eliminatedPlayerIds: string[];
}

// 夜晚阶段只允许平民和卧底提交动作。
export interface NightActionRecord {
  actorId: string;
  actorRole: Extract<PlayerRole, "civilian" | "undercover">;
  targetId?: string;
}

export interface PrivilegedActionPreview {
  votes: VoteRecord[];
  nightActions: Array<{
    actorId: string;
    targetId?: string;
  }>;
}

// 白板猜词记录既用于结算，也用于前端展示历史。
export interface BlankGuessRecord {
  playerId: string;
  guessedWords: [string, string];
  success: boolean;
  createdAt: number;
  reason: BlankGuessReason;
  /** 自动比对未通过、由主持人判定为正确时置位，用于结算复盘。 */
  approvedByQuestioner?: boolean;
}

export interface VoteHistoryRecord {
  day: number;
  tieBreak?: boolean;
  votes: VoteRecord[];
}

// 某个玩家在当前局内的运行时状态。
export interface RoundPlayerState {
  role: PlayerRole;
  side: PlayerSide;
  word?: string;
  alive: boolean;
  eliminatedAt?: number;
  eliminatedReason?: string;
}

// 平票 PK 的临时状态，只在 tieBreak 阶段存在。
export interface TieBreakState {
  candidateIds: string[];
  stage: TieBreakStage;
  descriptionsDone: string[];
  votes: VoteRecord[];
}

/** 白板进入猜词阶段的原因，公开给全房，让其他人知道为什么被打断。 */
export type BlankGuessReason = "active" | "eliminated" | "finale";

// 白板猜词是阻塞阶段，服务端需要记住猜词结束后要回到哪个阶段。
export interface BlankGuessContext {
  playerId: string;
  reason: BlankGuessReason;
  resumePhase?: Exclude<GamePhase, "blankGuess" | "assigningQuestioner" | "wordSubmission">;
  deferredWinner?: Exclude<RoundWinner, "blank" | "aborted">;
  /** 打断发言/投票等原阶段时暂存的剩余倒计时毫秒数，供裁定未通过恢复原阶段时还原。 */
  interruptedRemainingTimerMs?: number;
  /**
   * 白板正在输入的草稿，全房实时可见。
   * 猜词过程本身是这一阶段的看点，因此不做保密。
   */
  draft?: [string, string];
  /**
   * 自动比对未通过、等待主持人裁定的那次猜测。
   * 存在时阶段仍然阻塞，只有主持人的裁定能推进。
   */
  pendingReview?: {
    words: [string, string];
  };
}

// 一局结束后的结算快照，供结算页和历史回顾直接复用。
export interface RoundSummary {
  winner: RoundWinner;
  reason: string;
  awardedScores: Array<{
    playerId: string;
    delta: number;
  }>;
  revealedRoles: Array<{
    playerId: string;
    role: PlayerRole;
  }>;
  descriptions: DescriptionRecord[];
  blankGuesses: BlankGuessRecord[];
  words?: {
    pair: [string, string];
    civilianWord: string;
    undercoverWord: string;
    blankHint?: string;
  };
  voteHistory?: VoteHistoryRecord[];
}

// 单局游戏的全部运行态。
export interface GameRound {
  id: string;
  phase: GamePhase;
  speechMode?: SpeechMode;
  day: number;
  questionerPlayerId?: string;
  words?: {
    pair: [string, string];
    civilianWord: string;
    undercoverWord: string;
    blankHint?: string;
  };
  assignments: Record<string, RoundPlayerState>;
  descriptionCycle: number;
  /** 当前描述轮次的随机发言顺序。 */
  descriptionOrder: string[];
  /** 当前局已发生的平票 PK 次数，每次进入 tieBreak 时自增，用于区分多次平票列。 */
  tieBreakCount: number;
  descriptions: DescriptionRecord[];
  descriptionSubmittedBy: string[];
  /** 出题人发起的当前轮补充发言请求，补充完成后清空。 */
  supplement?: {
    /** 本局第几次补充，1-based。 */
    index: number;
    /** 被要求补充发言的玩家 ID 列表。 */
    requestedPlayerIds: string[];
    /** 已完成补充的玩家 ID 列表。 */
    donePlayers: string[];
    /** 补充完成后恢复的阶段。 */
    resumePhase: "description" | "voting";
  };
  votes: VoteRecord[];
  voteHistory: VoteHistoryRecord[];
  tieBreak?: TieBreakState;
  nightActions: NightActionRecord[];
  blankGuessUsed: boolean;
  blankGuessRecords: BlankGuessRecord[];
  blankGuessContext?: BlankGuessContext;
  pendingDisconnectPlayerIds: string[];
  questionerReconnectDeadlineAt?: number;
  phaseTimer?: PhaseTimerState;
  summary?: RoundSummary;
}

// 房间的运行时总状态，RoomService 的核心持有对象。
export interface WhoIsFakerRoomRecord {
  id: string;
  settings: RoomSettings;
  hostPlayerId: string;
  /** 房主断线后的重连宽限期，过期后才自动转移房主。 */
  hostReconnectDeadlineAt?: number;
  /** 所有连接暂时断开后的回收时间；显式离开仍可立即关闭。 */
  emptySinceAt?: number;
  phaseTimer?: PhaseTimerState;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  players: Record<string, PlayerRecord>;
  chat: ChatMessage[];
  round?: GameRound;
}

export type RoomRecord = WhoIsFakerRoomRecord;

// 大厅列表使用的轻量房间摘要。
export interface WhoIsFakerRoomSummary {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  playerCount: number;
  onlineCount: number;
  phase: GamePhase;
  testMode: boolean;
}

export type RoomSummary = WhoIsFakerRoomSummary;

// 房间公共玩家视图，不包含秘密词语与隐藏身份。
export interface PublicPlayerView {
  id: string;
  name: string;
  score: number;
  membership: PlayerMembership;
  online: boolean;
  isReady: boolean;
  isBot: boolean;
  isHost: boolean;
  roundStatus:
    | "waiting"
    | "questioner"
    | "alive"
    | "dead"
    | "spectator"
    | "kicked";
  revealedRole?: PlayerRole;
  eliminatedAt?: number;
}

// 房间公共快照，所有房间成员都能收到。
export interface WhoIsFakerRoomSnapshot {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  hostPlayerId: string;
  testMode: boolean;
  roleLimits: RoleLimits;
  settings: {
    roleConfig: RoleConfig;
  };
  status: {
    phase: GamePhase;
    /** 本局的唯一标识。局外为 undefined；换局必变，客户端据此清空跨局状态（如身份预测）。 */
    roundId?: string;
    speechMode?: SpeechMode;
    speechResumePhase?: "description" | "voting";
    supplementIndex?: number;
    started: boolean;
    day: number;
    /** 当前描述轮次的公开发言顺序。 */
    descriptionOrder?: string[];
    /** 当前发言子阶段的完整顺序，普通描述、补充发言与平票 PK 共用。 */
    speechOrder?: string[];
    /** 当前发言子阶段已经提交的玩家；仅公开提交状态，不提前公开发言内容。 */
    submittedSpeechPlayerIds?: string[];
    questionerPlayerId?: string;
    tieBreakStage?: TieBreakStage;
    /** 当前平票 PK 的编号，仅在 tieBreak 阶段存在。 */
    tieBreakIndex?: number;
    /** 当前平票 PK 的候选玩家。 */
    tieBreakCandidateIds?: string[];
    pendingDisconnectPlayerId?: string;
    questionerReconnectDeadlineAt?: number;
    blankGuessPlayerId?: string;
    /** 白板进入猜词的原因，用于向全房说明这次打断从何而来。 */
    blankGuessReason?: BlankGuessReason;
    /** 白板正在输入的草稿，全房实时可见。 */
    blankGuessDraft?: [string, string];
    /** 自动比对未通过，正在等主持人裁定。 */
    blankGuessPendingReview?: boolean;
    /** 出题人发起补充发言时，尚未完成补充的玩家 ID 列表。 */
    pendingSupplementPlayerIds?: string[];
    /** 当前阶段倒计时运行时状态 */
    phaseTimer?: PhaseTimerState;
  };
  players: PublicPlayerView[];
  descriptions: DescriptionRecord[];
  chat: ChatMessage[];
  summary?: RoundSummary;
}

export type RoomSnapshot = WhoIsFakerRoomSnapshot;

// 每个连接单独收到的私有视图，用于承载秘密信息。
export interface WhoIsFakerPrivateState {
  playerId: string;
  sessionToken: string;
  role?: PlayerRole;
  side?: PlayerSide;
  word?: string;
  angelWordOptions?: [string, string];
  blankHint?: string;
  isQuestioner: boolean;
  canSubmitBlankGuess: boolean;
  blankGuessUsed: boolean;
  nightActionSubmitted: boolean;
  /**
   * 本局的全部词语。只发给已经能看到全部身份的出题人与旁观者，
   * 出局玩家仍留在场上交流，因此不在此列。
   */
  globalWords?: {
    civilianWord: string;
    undercoverWord: string;
    blankHint?: string;
  };
  /** 当前玩家在本轮投票中已投出的目标玩家 ID（含平票 PK 阶段）。 */
  myCurrentVoteTargetId?: string;
  /** 当前玩家本次夜晚已选择的目标玩家 ID；已提交但选择「不行动」时为 undefined。 */
  myCurrentNightTargetId?: string;
  questionerView?: Array<{
    playerId: string;
    role: PlayerRole;
    side: PlayerSide;
    alive: boolean;
  }>;
  /** 仅出题人和旁观者收到的当前投票与夜间行动预览。 */
  privilegedActionPreview?: PrivilegedActionPreview;
}

export type PrivateState = WhoIsFakerPrivateState;

// ==================== 谁是卧底客户端信封与消息 ====================

export type WhoIsFakerClientEnvelope<TType extends string, TPayload> = ClientEnvelope<TType, TPayload>;

export type WhoIsFakerClientMessage =
  | ClientEnvelope<"lobby.subscribeRooms", Record<string, never>>
  | ClientEnvelope<
      "room.create",
      {
        roomId: string;
        name: string;
        visibility: RoomVisibility;
        password?: string;
        allowSpectators: boolean;
        userName: string;
        roleConfig?: RoleConfig;
      }
    >
  | ClientEnvelope<
      "room.join",
      {
        userName: string;
        password?: string;
      }
    >
  | ClientEnvelope<
      "room.reconnect",
      {
        roomId: string;
        sessionToken: string;
      }
    >
  | ClientEnvelope<"room.leave", Record<string, never>>
  | ClientEnvelope<"room.requestSync", Record<string, never>>
  | ClientEnvelope<"player.rename", { name: string }>
  | ClientEnvelope<"player.setSpectator", { spectator: boolean }>
  | ClientEnvelope<"player.setReady", { ready: boolean }>
  | ClientEnvelope<
      "room.updateSettings",
      {
        name?: string;
        visibility?: RoomVisibility;
        password?: string;
        allowSpectators?: boolean;
        roleConfig?: RoleConfig;
      }
    >
  | ClientEnvelope<"room.kick", { playerId: string }>
  | ClientEnvelope<"game.assignQuestioner", { playerId: string }>
  | ClientEnvelope<
      "game.submitWords",
      {
        words: [string, string];
        blankHint?: string;
        manualRoles?: Record<string, PlayerRole>;
      }
    >
  | ClientEnvelope<"game.advancePhase", Record<string, never>>
  | ClientEnvelope<"game.submitDescription", { text: string }>
  | ClientEnvelope<"game.submitVote", { targetId: string }>
  | ClientEnvelope<"game.submitNightAction", { targetId?: string | null }>
  | ClientEnvelope<"game.submitBlankGuess", { words: [string, string] }>
  | ClientEnvelope<"game.enterBlankGuess", Record<string, never>>
  | ClientEnvelope<"game.updateBlankGuessDraft", { words: [string, string] }>
  | ClientEnvelope<"game.reviewBlankGuess", { approve: boolean }>
  | ClientEnvelope<
      "game.resolveDisconnect",
      { playerId: string; resolution: DisconnectResolution }
    >
  | ClientEnvelope<"chat.send", { text: string }>
  | ClientEnvelope<"room.transferHost", { playerId: string }>
  | ClientEnvelope<"test.jumpToPhase", { phase: GamePhase }>
  | ClientEnvelope<"test.setMyRole", { role: PlayerRole }>
  | ClientEnvelope<"test.addBot", { count?: number }>
  | ClientEnvelope<"test.removeBot", { playerId?: string; count?: number }>
  | ClientEnvelope<"game.cancelVote", Record<string, never>>
  | ClientEnvelope<"game.cancelNightAction", Record<string, never>>
  | ClientEnvelope<"game.requestSupplement", { playerIds: string[] }>
  | ClientEnvelope<"game.startPhaseTimer", { durationSeconds: number }>
  | ClientEnvelope<"game.stopPhaseTimer", Record<string, never>>;

export type ClientMessage = WhoIsFakerClientMessage;
export type FakerClientMessage = WhoIsFakerClientMessage;
