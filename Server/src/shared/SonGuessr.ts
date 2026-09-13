import type { ChatMessage, RoomVisibility } from "./Model";

export const SONGUESSR_PHASES = [
  "waiting",
  "choosingSubmitter",
  "submittingSong",
  "playing",
  "roundResult",
] as const;

export type SonGuessrPhase = (typeof SONGUESSR_PHASES)[number];

export const MAX_SONGUESSR_COOKIE_LENGTH = 16_384;

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

export interface BangumiSubjectSearchResult {
  id: string;
  name: string;
  nameCn: string;
  imageUrl?: string;
  year?: number;
  rating?: number;
  ratingCount?: number;
  tags: string[];
  metaTags: string[];
}

export type BangumiMusicTrackKind =
  | "opening"
  | "ending"
  | "insert"
  | "theme"
  | "ost"
  | "character"
  | "remix"
  | "doujin"
  | "image"
  | "vocaloid"
  | "drama"
  | "vocal"
  | "radio"
  | "arrange"
  | "single"
  | "collection"
  | "reading"
  | "artistAlbum";

export const ALL_BANGUMI_TRACK_KINDS: readonly BangumiMusicTrackKind[] = [
  "opening",
  "ending",
  "insert",
  "theme",
  "ost",
  "character",
  "remix",
  "doujin",
  "image",
  "vocaloid",
  "drama",
  "vocal",
  "radio",
  "arrange",
  "single",
  "collection",
  "reading",
  "artistAlbum",
] as const;

export const BANGUMI_TRACK_KIND_LABELS: Record<BangumiMusicTrackKind, string> = {
  opening: "OP",
  ending: "ED",
  insert: "插曲",
  theme: "主题曲",
  ost: "OST",
  character: "角色曲",
  remix: "Remix",
  doujin: "同人音乐",
  image: "印象曲",
  vocaloid: "Vocaloid",
  drama: "Drama",
  vocal: "VOCAL",
  radio: "Radio",
  arrange: "Arrange",
  single: "单曲",
  collection: "精选集",
  reading: "朗读剧",
  artistAlbum: "艺人专辑",
};

/**
 * 从歌曲元数据（曲名 / 专辑 / 标签）中提取无歧义的主题曲类型标注。
 *
 * Bangumi 的关联条目分类经常比网易云歌曲自身标注更粗：官方 MV、单曲碟会被归到
 * 「其他 → 主题曲」，片尾曲的专辑条目也可能挂在「插入歌」下。因此当歌曲元数据里
 * 明确写着「片尾曲 / ED」时，必须以歌曲标注为准确认类型，否则会出现
 * 「片尾曲的歌配着插曲徽章」这类错配。
 *
 * 只认可带「曲 / 歌 / テーマ」后缀或完整英文单词的写法，避免把普通歌名里
 * 偶然出现的 `in`、`ed` 片段误判成插入歌或片尾曲。
 *
 * 服务端曲目校准与客户端徽章展示共用本函数，保证两端判定一致。
 */
export const detectExplicitTrackKind = (text: string): BangumiMusicTrackKind | undefined => {
  if (/片尾曲|片尾歌|片尾主題歌|片尾主题歌|エンディングテーマ|エンディング|\bending\b/i.test(text)) return "ending";
  if (/片头曲|片頭曲|片头歌|片头主題歌|片头主题歌|オープニングテーマ|オープニング|\bopening\b/i.test(text)) return "opening";
  if (/插入歌|插曲|挿入歌|剧中歌|劇中歌|\binsert\s*song\b/i.test(text)) return "insert";
  return undefined;
};

export interface BangumiMusicTrack {
  title: string;
  artist?: string;
  kind: BangumiMusicTrackKind;
}

export interface BangumiSubjectDetails extends BangumiSubjectSearchResult {
  summary?: string;
  locked?: boolean;
  musicTracks: BangumiMusicTrack[];
}

export interface AnimeAutoFilters {
  startYear?: number;
  endYear?: number;
  ranking?: "all" | "year";
  subjectLimit?: number;
  songMinPopularity?: SongAutoFilters["minPopularity"];
  trackKinds?: BangumiMusicTrack["kind"][];
}

export interface SonGuessrSettings {
  questionType: SongQuestionType;
  questionMode: SongQuestionMode;
  autoRotateSubmitter: boolean;
  autoFilters: SongAutoFilters;
  animeAutoFilters?: AnimeAutoFilters;
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

export interface SongChorus {
  startTime: number;
  endTime?: number;
}

export interface SongDetails extends SongSearchResult {
  audioUrl: string;
  lyrics: SongLyricLine[];
  releaseYear?: number;
  popularity?: number;
  language?: string;
  encyclopedia: SongEncyclopedia;
  chorus?: SongChorus;
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
  guessedAnime?: BangumiSubjectSearchResult;
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
    audioUrl?: string;
    chorus?: SongChorus;
  };
  anime?: BangumiSubjectSearchResult;
  animeTrack?: BangumiMusicTrack;
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
  spectatorCount: number;
  onlineCount: number;
  phase: SonGuessrPhase;
}

export interface SonGuessrRoomSnapshot {
  roomId: string;
  name: string;
  /** 单人房间：无玩家栏、无聊天、由系统自动出题，不允许其他玩家加入。 */
  solo: boolean;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
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
  submittedAnime?: BangumiSubjectSearchResult;
  visibleAttempts: SongGuessAttempt[];
}

import type { ClientEnvelope } from "./Protocol";

export type SonGuessrClientEnvelope<TType extends string, TPayload> = ClientEnvelope<TType, TPayload>;

export type SonGuessrClientMessage =
  | ClientEnvelope<"song.lobby.subscribeRooms", Record<string, never>>
  | ClientEnvelope<
      "song.room.create",
      {
        roomId: string;
        name: string;
        visibility: RoomVisibility;
        password?: string;
        allowSpectators: boolean;
        userName: string;
        solo?: boolean;
      }
    >
  | ClientEnvelope<"song.room.join", { userName: string; password?: string }>
  | ClientEnvelope<
      "song.room.reconnect",
      { roomId: string; sessionToken: string }
    >
  | ClientEnvelope<"song.room.leave", Record<string, never>>
  | ClientEnvelope<"song.room.requestSync", Record<string, never>>
  | ClientEnvelope<"song.player.setReady", { ready: boolean }>
  | ClientEnvelope<"song.player.setSpectator", { spectator: boolean }>
  | ClientEnvelope<
      "song.room.updateSettings",
      Partial<SonGuessrSettings> & {
        name?: string;
        visibility?: RoomVisibility;
        password?: string;
        allowSpectators?: boolean;
      }
    >
  | ClientEnvelope<"song.room.kick", { playerId: string }>
  | ClientEnvelope<"song.room.transferHost", { playerId: string }>
  | ClientEnvelope<"song.chat.send", { text: string }>
  | ClientEnvelope<"song.auth.qr.create", Record<string, never>>
  | ClientEnvelope<"song.auth.qr.check", { key: string }>
  | ClientEnvelope<"song.auth.useCookie", { cookie: string }>
  | ClientEnvelope<"song.auth.clear", Record<string, never>>
  | ClientEnvelope<"song.music.search", { keyword: string }>
  | ClientEnvelope<"song.music.playlist.resolve", { value: string }>
  | ClientEnvelope<"song.music.artist.search", { keyword: string }>
  | ClientEnvelope<"song.bangumi.search", { keyword: string }>
  | ClientEnvelope<"song.game.start", Record<string, never>>
  | ClientEnvelope<"song.game.chooseSubmitter", { playerId: string }>
  | ClientEnvelope<"song.game.submitSong", { songId: string }>
  | ClientEnvelope<"song.game.submitAnime", { subjectId: string }>
  | ClientEnvelope<"song.game.audioReady", { roundNumber: number }>
  | ClientEnvelope<"song.game.audioFailed", { roundNumber: number }>
  | ClientEnvelope<"song.game.guess", { songId: string }>
  | ClientEnvelope<"song.game.guessAnime", { subjectId: string }>
  | ClientEnvelope<"song.game.giveUp", Record<string, never>>
  | ClientEnvelope<"song.game.skipRound", Record<string, never>>
  | ClientEnvelope<"song.game.nextRound", Record<string, never>>
  | ClientEnvelope<"song.game.finish", Record<string, never>>
  | ClientEnvelope<"song.test.addBot", { count?: number }>
  | ClientEnvelope<"song.test.removeBot", { count?: number }>;
