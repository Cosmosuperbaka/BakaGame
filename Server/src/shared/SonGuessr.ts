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

/**
 * 判断 Bangumi 关联条目是否为「版权署名 / 制作委员会」伪条目。
 *
 * Bangumi 的关联条目里混入了大量并非歌曲的署名条目，例如
 * `©BanG Dream! Project`、`©SUNRISE`、`©Visual Art's`、`©2007 竜騎士07`、
 * `（C）2009 NEOPLE`、`Ⓒ 創通・タツノコプロ`、`時をかける少女」製作委員会2006`。
 * 它们本地的 `music_id` 为负数（实测全库 7762 条），却被归到 `opening` 类目，
 * 按 `KIND_PRIORITY` 排在所有真实曲目之前。
 *
 * 若不剔除，解析关联歌曲时会拿「版权署名」去网易云搜歌，再经宽松的子串
 * 匹配把完全无关的歌曲当成 OP——例如把 2019 年专辑《Music For All》里的
 * 《Bang Dream!》当作 2023 年《BanG Dream! It's MyGO!!!!!》的 OP。
 *
 * 判定必须**只认无歧义的版权标记**，否则会误杀带美术字符的正常曲名。
 * 实测教训：把 `♡ / ❤ / ※ / Project$ / オール` 列入规则会误杀 126 首正版歌曲
 * （`unconditional L♡VE`、`♡km/h`、`Love❤Island`、`μ's オリジナルソングCD`、
 * `のだめカンタービレ オールシーズンズベスト` 等），故一概不予采用。
 *
 * 服务端两个 Bangumi Provider 与本模块的曲名门禁共用本函数，保证判定一致。
 */
export const isBangumiCreditsEntry = (title: string): boolean => {
  const value = title.trim();
  if (!value) return true;
  // 版权 / 商标 / 录音权标记：© ® ℗ 与 (C)/(R)/(P) 全角变体，任意位置出现即视为署名条目。
  // 注意：❤ ♡ ※ ☆ 等美术字符是正常曲名常用元素，绝不能纳入判定。
  if (/[©®℗Ⓒⓒ]|\(\s*[cC]\s*\)|（\s*[cCｃＣ]\s*）|\(\s*[rR]\s*\)|（\s*[rRＲ]\s*）|\(\s*[pP]\s*\)|（\s*[pPＰ]\s*）/.test(value)) return true;
  // 制作 / 製作委員会署名（且不含任何歌曲语义关键词）。如「時をかける少女」製作委員会2006。
  if (/(?:製作|制作)委員会|製作委員会/.test(value) &&
      !/曲|歌|テーマ|theme|opening|ending|insert/i.test(value)) {
    return true;
  }
  return false;
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

export interface SongLyricWord {
  startTime: number;
  endTime: number;
  word: string;
  romanWord?: string;
}

export interface SongLyricLine {
  time: number;
  endTime: number;
  text: string;
  words?: SongLyricWord[];
  translatedLyric?: string;
  romanLyric?: string;
  isBG?: boolean;
  isDuet?: boolean;
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
