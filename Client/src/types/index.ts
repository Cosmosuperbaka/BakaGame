// ==================== 游戏类型定义（与后端 model.ts 对齐） ====================

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

export type PlayerRole = "civilian" | "undercover" | "angel" | "blank";
export type PlayerSide = "good" | "undercover" | "blank";
export type RoomVisibility = "public" | "private";
export type PlayerMembership = "active" | "spectator" | "kicked";
export type DescriptionKind = "description" | "tieBreak";
export type TieBreakStage = "description" | "vote";
export type DisconnectResolution = "wait" | "eliminate";
export type RoundWinner = "good" | "undercover" | "blank" | "aborted";

export interface RoleConfig {
  undercoverCount: number;
  hasAngel: boolean;
  hasBlank: boolean;
}

export interface RoleLimits {
  maxUndercoverCount: number;
  canEnableAngel: boolean;
  canEnableBlank: boolean;
}

export interface DescriptionRecord {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  kind: DescriptionKind;
  cycle: number;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  createdAt: number;
  system: boolean;
}

export interface VoteRecord {
  voterId: string;
  targetId: string;
}

export interface BlankGuessRecord {
  playerId: string;
  guessedWords: [string, string];
  success: boolean;
  createdAt: number;
  reason: "active" | "eliminated" | "finale";
}

export interface RoundSummary {
  winner: RoundWinner;
  reason: string;
  awardedScores: Array<{ playerId: string; delta: number }>;
  revealedRoles: Array<{ playerId: string; role: PlayerRole }>;
  descriptions: DescriptionRecord[];
  blankGuesses: BlankGuessRecord[];
}

export interface PublicPlayerView {
  id: string;
  name: string;
  score: number;
  membership: PlayerMembership;
  online: boolean;
  isReady: boolean;
  isBot: boolean;
  isHost: boolean;
  roundStatus: "waiting" | "questioner" | "alive" | "dead" | "spectator" | "kicked";
  revealedRole?: PlayerRole;
}

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

export interface RoomSummaryItem {
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

// ==================== WebSocket 消息类型 ====================

export interface AckPacket {
  type: "ack";
  id: string;
  requestType: string;
  payload?: Record<string, unknown>;
}

export interface ErrorPacket {
  type: "error";
  id: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface EventPacket {
  type: "event";
  event: string;
  payload: unknown;
}

export type ServerMessage = AckPacket | ErrorPacket | EventPacket;

// ==================== 版本信息 ====================

export interface VersionInfo {
  name: string;
  version: string;
  commit: string;
  buildTime: string;
}
