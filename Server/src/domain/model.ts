// ==================== 全局常量与类型模型 ====================

// 特殊房间号：进入单人测试模式，服务端会自动补齐 Bot。
export const ROOM_ID_TEST_MODE = "Oblivionis";

// 游戏主状态机的阶段定义。
export const GAME_PHASES = [
  "waiting",
  "assigningQuestioner",
  "wordSubmission",
  "description",
  "voting",
  "tieBreak",
  "night",
  "daybreak",
  "blankGuess",
  "gameOver",
] as const;

export type GamePhase = (typeof GAME_PHASES)[number];

export const PLAYER_ROLES = [
  "civilian",
  "undercover",
  "angel",
  "blank",
] as const;

export type PlayerRole = (typeof PLAYER_ROLES)[number];
export type PlayerSide = "good" | "undercover" | "blank";
export type RoomVisibility = "public" | "private";
export type PlayerMembership = "active" | "spectator" | "kicked";
export type DescriptionKind = "description" | "tieBreak";
export type TieBreakStage = "description" | "vote";
export type DisconnectResolution = "wait" | "eliminate";
export type RoundWinner = "good" | "undercover" | "blank" | "aborted";

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

export interface PlayerRecord {
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

// 每条描述都带上阶段类型与轮次，便于结算时回放。
export interface DescriptionRecord {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  kind: DescriptionKind;
  cycle: number;
  createdAt: number;
}

// 房间聊天与系统提示共用一个消息结构，靠 system 字段区分。
export interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  createdAt: number;
  system: boolean;
}

// 投票阶段只记录“谁投给了谁”，统计在运行时计算。
export interface VoteRecord {
  voterId: string;
  targetId: string;
}

// 夜晚阶段只允许平民和卧底提交动作。
export interface NightActionRecord {
  actorId: string;
  actorRole: Extract<PlayerRole, "civilian" | "undercover">;
  targetId?: string;
}

// 白板猜词记录既用于结算，也用于前端展示历史。
export interface BlankGuessRecord {
  playerId: string;
  guessedWords: [string, string];
  success: boolean;
  createdAt: number;
  reason: "active" | "eliminated" | "finale";
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

// 白板被动猜词时，服务端需要记住猜词结束后要回到哪个阶段。
export interface BlankGuessContext {
  playerId: string;
  reason: "eliminated" | "finale";
  resumePhase?: Exclude<GamePhase, "blankGuess" | "assigningQuestioner" | "wordSubmission">;
  deferredWinner?: Exclude<RoundWinner, "blank" | "aborted">;
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
}

// 单局游戏的全部运行态。
export interface GameRound {
  id: string;
  phase: GamePhase;
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
  descriptions: DescriptionRecord[];
  descriptionSubmittedBy: string[];
  votes: VoteRecord[];
  tieBreak?: TieBreakState;
  nightActions: NightActionRecord[];
  blankGuessUsed: boolean;
  blankGuessRecords: BlankGuessRecord[];
  blankGuessContext?: BlankGuessContext;
  pendingDisconnectPlayerIds: string[];
  questionerReconnectDeadlineAt?: number;
  summary?: RoundSummary;
}

// 房间的运行时总状态，RoomService 的核心持有对象。
export interface RoomRecord {
  id: string;
  settings: RoomSettings;
  hostPlayerId: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  players: Record<string, PlayerRecord>;
  chat: ChatMessage[];
  round?: GameRound;
}

// 大厅列表使用的轻量房间摘要。
export interface RoomSummary {
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
}

// 房间公共快照，所有房间成员都能收到。
export interface RoomSnapshot {
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
    started: boolean;
    day: number;
    questionerPlayerId?: string;
    tieBreakStage?: TieBreakStage;
    pendingDisconnectPlayerId?: string;
    questionerReconnectDeadlineAt?: number;
    blankGuessPlayerId?: string;
  };
  players: PublicPlayerView[];
  descriptions: DescriptionRecord[];
  chat: ChatMessage[];
  summary?: RoundSummary;
}

// 每个连接单独收到的私有视图，用于承载秘密信息。
export interface PrivateState {
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
  questionerView?: Array<{
    playerId: string;
    role: PlayerRole;
    side: PlayerSide;
    alive: boolean;
  }>;
}

// RoomService 注册到连接池里的最小连接抽象。
export interface ConnectionRecord {
  id: string;
  roomId?: string;
  playerId?: string;
  lobbySubscribed: boolean;
  send: (payload: unknown) => void;
  close: (code?: number, reason?: string) => void;
}
