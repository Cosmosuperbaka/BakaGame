import { Type as t, type Static } from "@sinclair/typebox";
import { schemaUnion } from "./SchemaUnion";
import { AgentFocusInputSchema } from "./AgentActivity";
import {
  createClientEnvelopeSchema,
  RoomVisibilitySchema,
  type ChatMessage,
  type PlayerAccount,
  type PlayerMembership,
  type RoomVisibility,
} from "./Model";
import type { ClientEnvelope } from "./Protocol";

// ==================== 谁是卧底 (WhoIsFaker) 领域模型与协议 ====================

const strict = { additionalProperties: false } as const;

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
  "feedback",
  "gameOver",
] as const;

export type WhoIsFakerPhase = (typeof WHOISFAKER_PHASES)[number];

export const WHOISFAKER_ROLES = ["civilian", "undercover", "angel", "blank"] as const;

export type WhoIsFakerRole = (typeof WHOISFAKER_ROLES)[number];
export type PlayerSide = "good" | "undercover" | "blank";
export type DescriptionKind = "description" | "tieBreak" | "supplement";
export type SpeechMode = "normal" | "supplement" | "tieBreak";
export type TieBreakStage = "description" | "vote";
const disconnectResolutionSchema = t.Union([t.Literal("wait"), t.Literal("eliminate")]);
export type RoundWinner = "good" | "undercover" | "blank" | "aborted";

/** 阶段倒计时运行时状态，严格仅限当前阶段生效。 */
export interface PhaseTimerState {
  /** 倒计时时长（秒）：60 | 120 | 180 */
  durationSeconds: number;
  /** 倒计时结束的绝对毫秒时间戳 */
  endsAt: number;
  /** 倒计时所属的游戏阶段 */
  phase: WhoIsFakerPhase;
  /** 触发时的发言模式（用于区分 normal / supplement / tieBreak） */
  speechMode?: SpeechMode;
  /** 触发时的平票PK阶段（用于区分 description / vote） */
  tieBreakStage?: TieBreakStage;
}

// 房主在开局前配置的阵营参数。
export const RoleConfigSchema = t.Object(
  {
    undercoverCount: t.Integer({ minimum: 0 }),
    hasAngel: t.Boolean(),
    hasBlank: t.Boolean(),
  },
  strict
);
export type RoleConfig = Static<typeof RoleConfigSchema>;

// 根据当前人数动态推导出的阵营上限。
export interface RoleLimits {
  maxUndercoverCount: number;
  canEnableAngel: boolean;
  canEnableBlank: boolean;
}

// 房间基础设置，前端编辑房间时主要围绕这一组字段。口令不在这里：明文只在请求里过一遍，
// 房间记录只留 argon2 摘要（见 WhoIsFakerRoomRecord.passwordHash）。
export interface RoomSettings {
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  roleConfig: RoleConfig;
  revealRoleOnDeath: boolean;
  /**
   * 旁观者能否在局中看到双侧答案与全员身份。默认关闭：
   * 「允许旁观」只决定能不能进场，不决定进场后看到多少，两者正交。
   * 结算后（gameOver）答案本来就随公开快照全房可见，这个开关只管局中。
   */
  spectatorsSeeAnswers: boolean;
  /** 是否允许 Agent（MCP）加入；缺省 false。 */
  allowAgents: boolean;
}

export interface WhoIsFakerPlayerRecord {
  id: string;
  sessionToken: string;
  name: string;
  score: number;
  membership: PlayerMembership;
  isReady: boolean;
  isBot: boolean;
  /** 通过 MCP 接入的 Agent 玩家；界面据此显示徽标，房间设置据此准入。 */
  isAgent?: boolean;
  online: boolean;
  joinedAt: number;
  lastSeenAt: number;
  connectionId?: string;
  /** 最近一次接管座位的连接所登录的账号。 */
  account?: PlayerAccount;
}

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
  /** 本轮发言顺位序号，1-based。 */
  order?: number;
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

// 夜晚阶段只允许平民和卧底提交动作。
export interface NightActionRecord {
  actorId: string;
  actorRole: Extract<WhoIsFakerRole, "civilian" | "undercover">;
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
  role: WhoIsFakerRole;
  side: PlayerSide;
  word?: string;
  alive: boolean;
  eliminatedAt?: number;
  eliminatedReason?: string;
}

/** 反馈之后要去的阶段，公开给全房，用于提示「继续后进入哪里」。 */
export type FeedbackNext = Extract<
  WhoIsFakerPhase,
  "description" | "voting" | "tieBreak" | "night" | "blankGuess" | "gameOver"
>;

/**
 * 阶段反馈：投票、夜晚与白板猜词结算后，先停在 `feedback` 阶段把结果摆给全房，
 * 由出题人手动继续。决出胜负时同样先反馈再结算。
 * 夜晚反馈只给出局者，不给凶手；票型在投票反馈里完整公开。
 */
export interface RoundFeedback {
  kind: "vote" | "night" | "blankGuess";
  /** 结果所属的天数（夜晚反馈即这一夜所在的天）。 */
  day: number;
  /** 投票反馈：是否为平票 PK 的第二轮投票。 */
  tieBreak?: boolean;
  /** 投票反馈：本轮全部选票，含弃票。 */
  votes?: VoteRecord[];
  /** 本次结算出局的玩家。 */
  eliminatedPlayerIds: string[];
  /** 投票反馈：平票后进入 PK 的候选。 */
  tieBreakCandidateIds?: string[];
  /** 白板猜词反馈：最终裁定后的猜词记录。 */
  blankGuess?: BlankGuessRecord;
  /** 白板猜词反馈：这次猜测经过主持人裁定（含裁定超时）。 */
  blankGuessReviewed?: boolean;
  next: FeedbackNext;
}

/**
 * 反馈阶段结束后的续接动作，只在服务端保存。续接在继续的那一刻才落地：
 * 反馈期间有人离场时，局面按当时的存活情况重新判定（可能直接分出胜负）。
 */
export type FeedbackContinuation =
  /** 投票后入夜、夜晚后天亮；先判白板残局猜词与胜负。 */
  | { type: "advance"; to: "night" | "daybreak"; winnerReason: string }
  /** 投票平票：继续后进入平票 PK，候选按当时仍存活的人重算。 */
  | { type: "tieBreak"; candidateIds: string[] }
  | { type: "finish"; winner: RoundWinner; reason: string }
  /**
   * 白板猜错：继续时按猜词上下文恢复原阶段或按残局结算。
   * `rosterChanged` 表示反馈期间有人离场，恢复前要按新局面复判胜负。
   */
  | { type: "blankFailed"; message: string; rosterChanged?: boolean };

/**
 * 本局按时间顺序的全局历史，结算时整份公开。描述阶段不记录（另有描述历史）。
 * 夜晚条目在结算时公开每个人的行动，包括凶手。
 */
export type RoundHistoryEntry =
  | {
      kind: "vote";
      day: number;
      createdAt: number;
      tieBreak?: boolean;
      votes: VoteRecord[];
      eliminatedPlayerIds: string[];
      tieBreakCandidateIds?: string[];
    }
  | {
      kind: "night";
      day: number;
      createdAt: number;
      actions: Array<{
        actorId: string;
        actorRole: NightActionRecord["actorRole"];
        targetId?: string;
      }>;
      eliminatedPlayerIds: string[];
    }
  | {
      kind: "blankGuess";
      day: number;
      createdAt: number;
      playerId: string;
      guessedWords: [string, string];
      success: boolean;
      reason: BlankGuessReason;
      reviewed?: boolean;
    }
  | {
      kind: "removal";
      day: number;
      createdAt: number;
      playerId: string;
      /** 主动离开、离线超时被清理、被房主移出、掉线后被出题人移出。 */
      reason: "left" | "timeout" | "kicked" | "disconnected";
    };

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
  resumePhase?: Exclude<FeedbackNext, "blankGuess">;
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
    role: WhoIsFakerRole;
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
  /** 按时间顺序的全局历史（描述阶段除外）。 */
  history?: RoundHistoryEntry[];
}

// 单局游戏的全部运行态。
export interface GameRound {
  id: string;
  phase: WhoIsFakerPhase;
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
  /** 当前阶段反馈，只在 `feedback` 阶段存在。 */
  feedback?: RoundFeedback;
  feedbackContinuation?: FeedbackContinuation;
  /** 本局按时间顺序的全局历史。 */
  history: RoundHistoryEntry[];
  summary?: RoundSummary;
}

// 房间的运行时总状态，WhoIsFakerService 的核心持有对象。
export interface WhoIsFakerRoomRecord {
  id: string;
  settings: RoomSettings;
  /** 私密房口令的 argon2 摘要；与 CEE 同一口径，明文不进房间记录、快照与日志。 */
  passwordHash?: string;
  hostPlayerId: string;
  /** 房主断线后的重连宽限期，过期后才自动转移房主。 */
  hostReconnectDeadlineAt?: number;
  /** 所有连接暂时断开后的回收时间；显式离开仍可立即关闭。 */
  emptySinceAt?: number;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  players: Record<string, WhoIsFakerPlayerRecord>;
  chat: ChatMessage[];
  round?: GameRound;
  /** 房间内已开启的对局总轮数，1-based 计数。 */
  roundCount?: number;
}

// 大厅列表使用的轻量房间摘要。
export interface WhoIsFakerRoomSummary {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  playerCount: number;
  spectatorCount: number;
  onlineCount: number;
  phase: WhoIsFakerPhase;
  testMode: boolean;
  /** 房间是否允许 MCP / Agent 接入；大厅据此显示 MCP 徽标。 */
  allowAgents?: boolean;
}

// 房间公共玩家视图，不包含秘密词语与隐藏身份。
export interface PublicPlayerView {
  id: string;
  name: string;
  score: number;
  membership: PlayerMembership;
  online: boolean;
  isReady: boolean;
  isBot: boolean;
  isAgent?: boolean;
  /** 该座位当前由 MCP 连接控制；人类会话只读。 */
  mcpControlled?: boolean;
  isHost: boolean;
  account?: PlayerAccount;
  roundStatus: "waiting" | "questioner" | "alive" | "dead" | "spectator" | "kicked";
  revealedRole?: WhoIsFakerRole;
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
    revealRoleOnDeath?: boolean;
    spectatorsSeeAnswers?: boolean;
    allowAgents?: boolean;
  };
  status: {
    phase: WhoIsFakerPhase;
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
    /** 阶段反馈，只在 `feedback` 阶段存在。 */
    feedback?: RoundFeedback;
  };
  players: PublicPlayerView[];
  descriptions: DescriptionRecord[];
  chat: ChatMessage[];
  summary?: RoundSummary;
}

// 每个连接单独收到的私有视图，用于承载秘密信息。
export interface WhoIsFakerPrivateState {
  playerId: string;
  sessionToken: string;
  /** 本座位已交给 MCP；人类连接收到的是脱敏私有状态。 */
  mcpControlled?: boolean;
  role?: WhoIsFakerRole;
  side?: PlayerSide;
  word?: string;
  angelWordOptions?: [string, string];
  blankHint?: string;
  isQuestioner: boolean;
  canSubmitBlankGuess: boolean;
  blankGuessUsed: boolean;
  nightActionSubmitted: boolean;
  /**
   * 本局的全部词语。只发给出题人，以及房间开启「旁观者可见答案」或已经结算的旁观者；
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
    role: WhoIsFakerRole;
    side: PlayerSide;
    alive: boolean;
  }>;
  /** 仅出题人、以及能看到全部身份的旁观者收到的当前投票与夜间行动预览。 */
  privilegedActionPreview?: PrivilegedActionPreview;
}

// ==================== 谁是卧底客户端指令契约（单一真相源） ====================
// 命令清单只有 `WhoIsFakerPayloadSchemas` 这一份：命令 union、载荷类型与运行时信封全部由它派生。
// 派生前这里是一张手写的信封联合，传输层另抄一份同构的 schema 表，两边一旦漏配就会出现
// 「类型有、处理器有、校验没有」的静默拒收。

/**
 * 大厅房间列表的事件名。服务端下发与传输层的积压丢弃口径读同一个常量：
 * 改名只改一处时，丢弃判定会静默失效，慢客户端继续吃全量扇出。
 */
export const WHOISFAKER_LOBBY_ROOMS_EVENT = "lobby.rooms";

const emptyPayload = t.Object({}, strict);
const positiveInt = t.Integer({ minimum: 1 });
const roomId = t.String({ minLength: 1, maxLength: 32 });
const userName = t.String({ minLength: 1, maxLength: 32 });
const password = t.Optional(t.String({ maxLength: 64 }));
const playerId = t.String({ minLength: 1, maxLength: 64 });
const sessionToken = t.String({ minLength: 1, maxLength: 128 });
const gamePhaseSchema = schemaUnion(WHOISFAKER_PHASES.map((phase) => t.Literal(phase)));
const playerRoleSchema = schemaUnion(WHOISFAKER_ROLES.map((role) => t.Literal(role)));
const wordPair = t.Tuple([
  t.String({ minLength: 1, maxLength: 50 }),
  t.String({ minLength: 1, maxLength: 50 }),
]);
const draftWordPair = t.Tuple([t.String({ maxLength: 50 }), t.String({ maxLength: 50 })]);

export const WhoIsFakerPayloadSchemas = {
  "lobby.subscribeRooms": emptyPayload,
  "room.create": t.Object(
    {
      roomId,
      name: t.String({ minLength: 1, maxLength: 40 }),
      visibility: RoomVisibilitySchema,
      password,
      allowSpectators: t.Boolean(),
      userName,
      roleConfig: t.Optional(RoleConfigSchema),
      allowAgents: t.Optional(t.Boolean()),
    },
    strict
  ),
  "room.join": t.Object({ userName, password }, strict),
  "room.reconnect": t.Object({ roomId, sessionToken }, strict),
  "room.leave": emptyPayload,
  "room.requestSync": emptyPayload,
  /** MCP 连接凭人类会话凭证认领座位；只有 Agent 连接可用。 */
  "mcp.claim": t.Object(
    { roomId, sessionToken: t.String({ minLength: 1, maxLength: 128 }) },
    strict
  ),
  /** 人类或控制器主动收回座位。 */
  "mcp.release": emptyPayload,
  /** MCP 上报「正在操作哪类界面」；不得携带答案、词语或搜索词。 */
  "mcp.focus": AgentFocusInputSchema,
  "player.rename": t.Object({ name: userName }, strict),
  "player.setSpectator": t.Object({ spectator: t.Boolean() }, strict),
  "player.setReady": t.Object({ ready: t.Boolean() }, strict),
  "room.updateSettings": t.Object(
    {
      name: t.Optional(t.String({ minLength: 1, maxLength: 40 })),
      visibility: t.Optional(RoomVisibilitySchema),
      password,
      allowSpectators: t.Optional(t.Boolean()),
      roleConfig: t.Optional(RoleConfigSchema),
      revealRoleOnDeath: t.Optional(t.Boolean()),
      spectatorsSeeAnswers: t.Optional(t.Boolean()),
      allowAgents: t.Optional(t.Boolean()),
    },
    strict
  ),
  "room.kick": t.Object({ playerId }, strict),
  "game.assignQuestioner": t.Object({ playerId }, strict),
  "game.submitWords": t.Object(
    {
      words: wordPair,
      blankHint: t.Optional(t.String({ maxLength: 50 })),
      manualRoles: t.Optional(t.Record(playerId, playerRoleSchema)),
    },
    strict
  ),
  "game.advancePhase": emptyPayload,
  "game.submitDescription": t.Object({ text: t.String({ minLength: 1, maxLength: 500 }) }, strict),
  "game.submitVote": t.Object({ targetId: playerId }, strict),
  "game.submitNightAction": t.Object(
    { targetId: t.Optional(t.Union([playerId, t.Null()])) },
    strict
  ),
  "game.submitBlankGuess": t.Object({ words: wordPair }, strict),
  "game.enterBlankGuess": emptyPayload,
  "game.updateBlankGuessDraft": t.Object({ words: draftWordPair }, strict),
  "game.reviewBlankGuess": t.Object({ approve: t.Boolean() }, strict),
  "game.resolveDisconnect": t.Object({ playerId, resolution: disconnectResolutionSchema }, strict),
  "chat.send": t.Object({ text: t.String({ minLength: 1, maxLength: 500 }) }, strict),
  "room.transferHost": t.Object({ playerId }, strict),
  "test.jumpToPhase": t.Object({ phase: gamePhaseSchema }, strict),
  "test.setMyRole": t.Object({ role: playerRoleSchema }, strict),
  "test.addBot": t.Object({ count: t.Optional(positiveInt) }, strict),
  "test.removeBot": t.Object(
    { playerId: t.Optional(playerId), count: t.Optional(positiveInt) },
    strict
  ),
  "game.cancelVote": emptyPayload,
  "game.cancelNightAction": emptyPayload,
  "game.requestSupplement": t.Object({ playerIds: t.Array(playerId, { minItems: 1 }) }, strict),
  "game.startPhaseTimer": t.Object({ durationSeconds: positiveInt }, strict),
  "game.stopPhaseTimer": emptyPayload,
} as const;

export type WhoIsFakerCommand = keyof typeof WhoIsFakerPayloadSchemas;
export type WhoIsFakerPayload<TCommand extends WhoIsFakerCommand> = Static<
  (typeof WhoIsFakerPayloadSchemas)[TCommand]
>;
export type WhoIsFakerClientMessage = {
  [K in WhoIsFakerCommand]: ClientEnvelope<K, WhoIsFakerPayload<K>>;
}[WhoIsFakerCommand];

const createWhoIsFakerMessageSchema = <K extends WhoIsFakerCommand>(type: K) =>
  createClientEnvelopeSchema(type, WhoIsFakerPayloadSchemas[type]);

export const WhoIsFakerMessageSchemas = Object.fromEntries(
  (Object.keys(WhoIsFakerPayloadSchemas) as WhoIsFakerCommand[]).map((type) => [
    type,
    createWhoIsFakerMessageSchema(type),
  ])
) as { [K in WhoIsFakerCommand]: ReturnType<typeof createWhoIsFakerMessageSchema<K>> };

export const WhoIsFakerClientMessageSchema = schemaUnion(Object.values(WhoIsFakerMessageSchemas));

/**
 * 进房三条命令的 ack：服务端 `restorePlayerConnection` / `handleRoomCreate` / `handleRoomJoin`
 * 的返回值就是这三行，快照与私有态另有 event 下发，不在 ack 里。
 */
export interface WhoIsFakerRoomEnterAck {
  roomId: string;
  playerId: string;
  sessionToken: string;
}

/**
 * 「发哪条命令 → 拿到什么形状的 ack」由命令表推导，客户端不再各自手写条件类型链。
 * 未列出的命令 ack 仍是任意对象：它们要么没有业务返回值，要么客户端只关心事件。
 */
export type WhoIsFakerAck<TCommand extends WhoIsFakerCommand> = TCommand extends
  "room.create" | "room.join" | "room.reconnect"
  ? WhoIsFakerRoomEnterAck
  : TCommand extends "lobby.subscribeRooms"
    ? { subscribed: true }
    : TCommand extends "room.leave"
      ? { left: true }
      : TCommand extends "room.requestSync"
        ? { synced: true }
        : Record<string, unknown>;
