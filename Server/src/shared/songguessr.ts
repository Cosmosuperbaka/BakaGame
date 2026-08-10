import type { ChatMessage, RoomVisibility } from "./model";

export const SONG_GUESSR_PHASES = [
  "waiting",
  "choosingSubmitter",
  "submittingSong",
  "playing",
  "roundResult",
  "gameOver",
] as const;

export type SongGuessrPhase = (typeof SONG_GUESSR_PHASES)[number];

export const SONG_GUESSR_MAX_PLAYERS = 16;

export interface SongGuessrSettings {
  lyricsLineCount: number;
  endOnFirstCorrect: boolean;
  maxGuessesPerRound: number;
  guessDurationSeconds: number;
}

export interface SongGuessrMusicAccount {
  userId?: string;
  nickname: string;
  avatarUrl?: string;
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

export interface SongGuessrScore {
  playerId: string;
  playerName: string;
  score: number;
  delta: number;
  correctGuesses: number;
  totalGuesses: number;
}

export interface SongGuessrRoundSummary {
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
  scores: SongGuessrScore[];
}

export interface SongGuessrPlayerView {
  id: string;
  name: string;
  score: number;
  membership: "active" | "spectator" | "kicked";
  online: boolean;
  isReady: boolean;
  isBot: boolean;
  isHost: boolean;
  correctGuesses: number;
  totalGuesses: number;
  roundStatus: "waiting" | "submitter" | "guessing" | "correct" | "finished" | "spectator";
  guessesUsed: number;
}

export interface SongGuessrRoomSummary {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  playerCount: number;
  onlineCount: number;
  maxPlayers: number;
  phase: SongGuessrPhase;
}

export interface SongGuessrRoomSnapshot {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  maxPlayers: number;
  hostPlayerId: string;
  testMode: boolean;
  musicAccountReady: boolean;
  settings: SongGuessrSettings;
  phase: SongGuessrPhase;
  roundNumber: number;
  pendingSubmitterPlayerId?: string;
  currentRound?: {
    roundNumber: number;
    submitterPlayerId: string;
    audioUrl: string;
    lyricClip: SongLyricClip;
  };
  players: SongGuessrPlayerView[];
  chat: ChatMessage[];
  roundSummary?: SongGuessrRoundSummary;
  finalScores?: SongGuessrScore[];
}

export interface SongGuessrPrivateState {
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

export interface SongGuessrClientEnvelope<TType extends string, TPayload> {
  id: string;
  type: TType;
  roomId?: string;
  sessionToken?: string;
  payload: TPayload;
}

export type SongGuessrClientMessage =
  | SongGuessrClientEnvelope<"song.lobby.subscribeRooms", Record<string, never>>
  | SongGuessrClientEnvelope<
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
  | SongGuessrClientEnvelope<"song.room.join", { userName: string; password?: string }>
  | SongGuessrClientEnvelope<
      "song.room.reconnect",
      { roomId: string; sessionToken: string }
    >
  | SongGuessrClientEnvelope<"song.room.leave", Record<string, never>>
  | SongGuessrClientEnvelope<"song.player.setReady", { ready: boolean }>
  | SongGuessrClientEnvelope<"song.player.setSpectator", { spectator: boolean }>
  | SongGuessrClientEnvelope<
      "song.room.updateSettings",
      Partial<SongGuessrSettings> & {
        name?: string;
        visibility?: RoomVisibility;
        password?: string;
        allowSpectators?: boolean;
      }
    >
  | SongGuessrClientEnvelope<"song.room.kick", { playerId: string }>
  | SongGuessrClientEnvelope<"song.room.transferHost", { playerId: string }>
  | SongGuessrClientEnvelope<"song.chat.send", { text: string }>
  | SongGuessrClientEnvelope<"song.auth.qr.create", Record<string, never>>
  | SongGuessrClientEnvelope<"song.auth.qr.check", { key: string }>
  | SongGuessrClientEnvelope<
      "song.auth.phone.sendCaptcha",
      { phone: string; countryCode?: string }
    >
  | SongGuessrClientEnvelope<
      "song.auth.phone.login",
      { phone: string; countryCode?: string; password?: string; captcha?: string }
    >
  | SongGuessrClientEnvelope<"song.auth.email.login", { email: string; password: string }>
  | SongGuessrClientEnvelope<"song.auth.useCookie", { cookie: string }>
  | SongGuessrClientEnvelope<"song.auth.clear", Record<string, never>>
  | SongGuessrClientEnvelope<"song.music.search", { keyword: string }>
  | SongGuessrClientEnvelope<"song.game.start", Record<string, never>>
  | SongGuessrClientEnvelope<"song.game.chooseSubmitter", { playerId: string }>
  | SongGuessrClientEnvelope<"song.game.submitSong", { songId: string }>
  | SongGuessrClientEnvelope<"song.game.audioReady", { roundNumber: number }>
  | SongGuessrClientEnvelope<"song.game.guess", { songId: string }>
  | SongGuessrClientEnvelope<"song.game.giveUp", Record<string, never>>
  | SongGuessrClientEnvelope<"song.game.skipRound", Record<string, never>>
  | SongGuessrClientEnvelope<"song.game.nextRound", Record<string, never>>
  | SongGuessrClientEnvelope<"song.game.finish", Record<string, never>>
  | SongGuessrClientEnvelope<"song.test.addBot", { count?: number }>
  | SongGuessrClientEnvelope<"song.test.removeBot", { count?: number }>;
