import type { ChatMessage, RoomVisibility } from "./Model";

export const SONGUESSR_PHASES = [
  "waiting",
  "choosingSubmitter",
  "submittingSong",
  "playing",
  "roundResult",
] as const;

export type SonGuessrPhase = (typeof SONGUESSR_PHASES)[number];

export const SONGUESSR_MAX_PLAYERS = 16;

export type SongQuestionType = "song" | "anime";
export type SongQuestionMode = "manual" | "automatic";

export interface SongArtistFilter {
  id: string;
  name: string;
}

export interface SongPlaylistFilter {
  id: string;
  name?: string;
  songCount?: number;
}

export interface SongAutoFilters {
  playlist?: SongPlaylistFilter;
  artists: SongArtistFilter[];
  minPopularity: 0 | 1_000 | 10_000 | 100_000;
}

export interface SonGuessrSettings {
  questionType: SongQuestionType;
  questionMode: SongQuestionMode;
  autoRotateSubmitter: boolean;
  autoFilters: SongAutoFilters;
  lyricsLineCount: number;
  showLyrics: boolean;
  bloodMode: boolean;
  maxGuessesPerRound: number;
  guessDurationSeconds: number;
  showGuessTimer: boolean;
}

export interface SonGuessrMusicAccount {
  userId?: string;
  nickname: string;
  avatarUrl?: string;
  /** 当前账号会员状态；未知表示网易云会员接口暂时不可用。 */
  vipStatus?: "vip" | "nonVip" | "unknown";
  vipType?: number;
  vipExpireTime?: number;
}

export interface SongLyricLine {
  time: number;
  endTime: number;
  text: string;
}

export interface SongLyricClip {
  startTime: number;
  endTime: number;
  lines: SongLyricLine[];
}

export interface SongSearchResult {
  id: string;
  title: string;
  artist: string;
  album?: string;
  pictureUrl?: string;
  durationMs?: number;
  requiresVip?: boolean;
  /** 网易云接口中的热度/播放热度字段；部分接口会对超大值做模糊化处理。 */
  popularity?: number;
}

export interface SongPlaylistInfo {
  id: string;
  name: string;
  songCount: number;
}

export interface SongArtistSearchResult {
  id: string;
  name: string;
  avatarUrl?: string;
}

export interface SongEncyclopedia {
  summary?: string;
  aliases?: string[];
  tags: string[];
}

export interface SongDetails extends SongSearchResult {
  audioUrl: string;
  lyrics: SongLyricLine[];
  releaseYear?: number;
  popularity?: number;
  language?: string;
  encyclopedia: SongEncyclopedia;
}

export type SongGuessDirection = "higher" | "lower" | "equal" | "unknown";

export interface SongGuessFeedback {
  releaseYear?: number;
  releaseYearDirection: SongGuessDirection;
  popularity?: number;
  popularityDirection: SongGuessDirection;
  languageMatch?: boolean;
  sharedTags: string[];
}

export interface SongGuessAttempt {
  id: string;
  playerId: string;
  playerName: string;
  guessNumber: number;
  createdAt: number;
  result: "wrong" | "timeout" | "correct" | "gaveUp";
  guessedSong?: SongSearchResult;
  feedback?: SongGuessFeedback;
}

export interface SonGuessrScore {
  playerId: string;
  playerName: string;
  score: number;
  delta: number;
  correctGuesses: number;
  totalGuesses: number;
}

export interface SonGuessrRoundSummary {
  roundNumber: number;
  song: SongSearchResult & {
    releaseYear?: number;
    popularity?: number;
    language?: string;
    encyclopedia: SongEncyclopedia;
  };
  submitterPlayerId: string;
  correctPlayerIds: string[];
  attempts: SongGuessAttempt[];
  scores: SonGuessrScore[];
}

export interface SonGuessrPlayerView {
  id: string;
  name: string;
  score: number;
  membership: "active" | "spectator" | "kicked";
  nextRoundMembership?: "active" | "spectator";
  online: boolean;
  isReady: boolean;
  isBot: boolean;
  isHost: boolean;
  correctGuesses: number;
  totalGuesses: number;
  roundStatus: "waiting" | "submitter" | "guessing" | "correct" | "finished" | "spectator";
  guessesUsed: number;
}

export interface SonGuessrRoomSummary {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  playerCount: number;
  onlineCount: number;
  maxPlayers: number;
  phase: SonGuessrPhase;
}

export interface SonGuessrRoomSnapshot {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  maxPlayers: number;
  hostPlayerId: string;
  testMode: boolean;
  musicAccountReady: boolean;
  settings: SonGuessrSettings;
  phase: SonGuessrPhase;
  roundNumber: number;
  pendingSubmitterPlayerId?: string;
  currentRound?: {
    roundNumber: number;
    submitterPlayerId: string;
    audioUrl: string;
    lyricClip: SongLyricClip;
  };
  players: SonGuessrPlayerView[];
  chat: ChatMessage[];
  roundSummary?: SonGuessrRoundSummary;
  finalScores?: SonGuessrScore[];
}

export interface SonGuessrPrivateState {
  playerId: string;
  sessionToken: string;
  isSubmitter: boolean;
  canSubmitSong: boolean;
  canGuess: boolean;
  canGiveUp: boolean;
  remainingGuesses: number;
  guessDeadlineAt?: number;
  submittedSong?: SongSearchResult;
  visibleAttempts: SongGuessAttempt[];
}

export interface SonGuessrClientEnvelope<TType extends string, TPayload> {
  id: string;
  type: TType;
  roomId?: string;
  sessionToken?: string;
  payload: TPayload;
}

export type SonGuessrClientMessage =
  | SonGuessrClientEnvelope<"song.lobby.subscribeRooms", Record<string, never>>
  | SonGuessrClientEnvelope<
      "song.room.create",
      {
        roomId: string;
        name: string;
        visibility: RoomVisibility;
        password?: string;
        allowSpectators: boolean;
        userName: string;
      }
    >
  | SonGuessrClientEnvelope<"song.room.join", { userName: string; password?: string }>
  | SonGuessrClientEnvelope<
      "song.room.reconnect",
      { roomId: string; sessionToken: string }
    >
  | SonGuessrClientEnvelope<"song.room.leave", Record<string, never>>
  | SonGuessrClientEnvelope<"song.room.requestSync", Record<string, never>>
  | SonGuessrClientEnvelope<"song.player.setReady", { ready: boolean }>
  | SonGuessrClientEnvelope<"song.player.setSpectator", { spectator: boolean }>
  | SonGuessrClientEnvelope<
      "song.room.updateSettings",
      Partial<SonGuessrSettings> & {
        name?: string;
        visibility?: RoomVisibility;
        password?: string;
        allowSpectators?: boolean;
      }
    >
  | SonGuessrClientEnvelope<"song.room.kick", { playerId: string }>
  | SonGuessrClientEnvelope<"song.room.transferHost", { playerId: string }>
  | SonGuessrClientEnvelope<"song.chat.send", { text: string }>
  | SonGuessrClientEnvelope<"song.auth.qr.create", Record<string, never>>
  | SonGuessrClientEnvelope<"song.auth.qr.check", { key: string }>
  | SonGuessrClientEnvelope<"song.auth.useCookie", { cookie: string }>
  | SonGuessrClientEnvelope<"song.auth.clear", Record<string, never>>
  | SonGuessrClientEnvelope<"song.music.search", { keyword: string }>
  | SonGuessrClientEnvelope<"song.music.playlist.resolve", { value: string }>
  | SonGuessrClientEnvelope<"song.music.artist.search", { keyword: string }>
  | SonGuessrClientEnvelope<"song.game.start", Record<string, never>>
  | SonGuessrClientEnvelope<"song.game.chooseSubmitter", { playerId: string }>
  | SonGuessrClientEnvelope<"song.game.submitSong", { songId: string }>
  | SonGuessrClientEnvelope<"song.game.audioReady", { roundNumber: number }>
  | SonGuessrClientEnvelope<"song.game.guess", { songId: string }>
  | SonGuessrClientEnvelope<"song.game.giveUp", Record<string, never>>
  | SonGuessrClientEnvelope<"song.game.skipRound", Record<string, never>>
  | SonGuessrClientEnvelope<"song.game.nextRound", Record<string, never>>
  | SonGuessrClientEnvelope<"song.game.finish", Record<string, never>>
  | SonGuessrClientEnvelope<"song.test.addBot", { count?: number }>
  | SonGuessrClientEnvelope<"song.test.removeBot", { count?: number }>;

// 兼容别名导出
export const SON_GUESSR_PHASES = SONGUESSR_PHASES;
export const SON_GUESSR_MAX_PLAYERS = SONGUESSR_MAX_PLAYERS;
export const SONG_GUESSR_PHASES = SONGUESSR_PHASES;
export const SONG_GUESSR_MAX_PLAYERS = SONGUESSR_MAX_PLAYERS;
export type SongGuessrPhase = SonGuessrPhase;
export type SongGuessrSettings = SonGuessrSettings;
export type SongGuessrMusicAccount = SonGuessrMusicAccount;
export type SongGuessrScore = SonGuessrScore;
export type SongGuessrRoundSummary = SonGuessrRoundSummary;
export type SongGuessrPlayerView = SonGuessrPlayerView;
export type SongGuessrRoomSummary = SonGuessrRoomSummary;
export type SongGuessrRoomSnapshot = SonGuessrRoomSnapshot;
export type SongGuessrPrivateState = SonGuessrPrivateState;
export type SongGuessrClientEnvelope<TType extends string, TPayload> = SonGuessrClientEnvelope<TType, TPayload>;
export type SongGuessrClientMessage = SonGuessrClientMessage;
