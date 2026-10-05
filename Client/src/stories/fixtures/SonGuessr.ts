import { waitFor } from "storybook/test";
import type {
  BangumiMusicTrack,
  BangumiSongCandidate,
  BangumiSubjectSearchResult,
  ChatMessage,
  SongGuessAttempt,
  SongLyricClip,
  SongLyricLine,
  SongSearchResult,
  SonGuessrMusicAccount,
  SonGuessrPlayerView,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
  SonGuessrRoomSummary,
  SonGuessrRoundSummary,
  SonGuessrScore,
  SonGuessrSettings,
} from "@/types";
import { clearStoredSongMusicSession, saveSongMusicSession } from "@/lib/SonGuessrMusicSession";
import { clearSongSoloRoomId, getSavedUsername, saveSongSoloRoomId, saveUsername } from "@/lib/Storage";
import { useSonGuessrStore, type SonGuessrStore } from "@/stores/UseSonGuessrStore";
import { presetSonGuessr } from "@/stories/StorePresets";
import { STORY_EPOCH, STORY_PLAYERS, STORY_SPECTATORS, placeholderImage } from "./Common";

// ==================== 猜歌故事的假数据 ====================
// 只供 Storybook 与截图使用。歌曲、歌手、番剧与歌词均为虚构，封面为纯色占位图。

export const SONG_ROOM_ID = "1234";
export const SONG_SOLO_ROOM_ID = "5678";
export const SONG_ROOM_ROUTER = { route: `/songuessr/room/${SONG_ROOM_ID}`, path: "/songuessr/room/:roomId" };
export const SONG_SOLO_ROUTER = { route: "/songuessr/solo", path: "/songuessr/solo" };

/** 与房间页游戏区一致的面板外壳；宽度取桌面三栏布局下游戏区的实际宽度。 */
export const SONG_STAGE_FRAME = "w-[36rem] max-w-full overflow-hidden rounded-md border bg-panel p-6 md:p-8";
/** 与房间页左侧玩家栏一致的面板外壳。 */
export const SONG_PLAYER_PANEL = "h-[36rem] w-[16rem] overflow-hidden rounded-md border bg-panel";

const [HOST, ME, PEACH, AZUMI, KANADE, , LONG] = STORY_PLAYERS;
const [PASSERBY] = STORY_SPECTATORS;

export const SONG_PEOPLE = { host: HOST, me: ME, peach: PEACH, azumi: AZUMI, kanade: KANADE, long: LONG, spectator: PASSERBY };

type Person = { id: string; name: string };

export function songPlayer(person: Person, overrides: Partial<SonGuessrPlayerView> = {}): SonGuessrPlayerView {
  return {
    id: person.id, name: person.name, score: 0, membership: "active", online: true, isReady: false, isBot: false,
    isHost: false, correctGuesses: 0, totalGuesses: 0, roundStatus: "waiting", guessesUsed: 0, ...overrides,
  };
}
/** 测试房间号下由服务端补入的人机，命名与服务端一致。 */
export function songBot(suffix: string, overrides: Partial<SonGuessrPlayerView> = {}): SonGuessrPlayerView {
  return songPlayer({ id: `bot-${suffix}`, name: `测试人机 ${suffix}` }, { isBot: true, isReady: true, ...overrides });
}

/** 与服务端默认设置一致。 */
export function songSettings(overrides: Partial<SonGuessrSettings> = {}): SonGuessrSettings {
  return {
    questionType: "song", questionMode: "manual", autoRotateSubmitter: false,
    autoFilters: { artists: [], minPopularity: 0 },
    animeAutoFilters: { ranking: "all", subjectLimit: 50, songMinPopularity: 0 },
    lyricsLineCount: 5, showLyrics: true, bloodMode: false, maxGuessesPerRound: 3,
    guessDurationSeconds: 60, showGuessTimer: true, ...overrides,
  };
}

/** 房主标记始终跟随 hostPlayerId，避免玩家栏与快照不一致。 */
export function songSnapshot(overrides: Partial<SonGuessrRoomSnapshot> = {}): SonGuessrRoomSnapshot {
  const snapshot: SonGuessrRoomSnapshot = {
    roomId: SONG_ROOM_ID, name: `${HOST.name}的房间`, solo: false, visibility: "public", allowSpectators: true,
    hasPassword: false, hostPlayerId: HOST.id, testMode: false, musicAccountReady: true, settings: songSettings(),
    phase: "waiting", roundNumber: 0, players: waitingPlayers(), chat: songChat(), ...overrides,
  };
  return { ...snapshot, players: snapshot.players.map((player) => ({ ...player, isHost: player.id === snapshot.hostPlayerId })) };
}

export function songPrivate(overrides: Partial<SonGuessrPrivateState> = {}): SonGuessrPrivateState {
  return {
    playerId: ME.id, sessionToken: "story-session", isSubmitter: false, canSubmitSong: false, canGuess: false,
    canGiveUp: false, remainingGuesses: 3, visibleAttempts: [], ...overrides,
  };
}

/** 让房间页直接落在已入房状态：路由房间号、Store 房间号与快照房间号三者一致即不会发起入房请求。 */
export function presetSongRoom(snapshot: SonGuessrRoomSnapshot, privateState: SonGuessrPrivateState) {
  presetSonGuessr({ connected: true, roomId: snapshot.roomId, sessionToken: privateState.sessionToken, snapshot, privateState });
}

type SongStoreActions = Pick<SonGuessrStore, "searchMusic" | "searchBangumi" | "resolveAnimeSongs" | "sendCommand" | "joinRoom">;

/** 替换 Store 上的网络动作；预览层在下一个故事前会整体重置 Store，替换不会外溢。 */
export function stubSongActions(actions: Partial<SongStoreActions>) {
  useSonGuessrStore.setState(actions);
}

/** 按命令类型应答的 `sendCommand` 替身。 */
export function stubSongCommand(handler: (type: string, payload?: Record<string, unknown>) => Promise<unknown>) {
  stubSongActions({ sendCommand: handler as unknown as SonGuessrStore["sendCommand"] });
}

/** 组件单独渲染玩家名单时补上房主标记（房间快照由 `songSnapshot` 负责）。 */
export const withHost = (players: SonGuessrPlayerView[], hostId: string = HOST.id) =>
  players.map((player) => ({ ...player, isHost: player.id === hostId }));

/** 阶段组件 `isPending` 的默认值：没有进行中的命令。 */
export const noPending: (type: string) => boolean = () => false;

/** 只有指定命令处于进行中。 */
export const pendingOn = (command: string) => (type: string): boolean => type === command;

/** 永不结算的请求，用于固定“查询中 / 提交中 / 生成中”这类进行态。 */
export const pending = <T>() => new Promise<T>(() => {});

/** 预置本机用户名；返回的清理函数恢复原值。 */
export function seedUsername(name: string) {
  const previous = getSavedUsername();
  saveUsername(name);
  return () => saveUsername(previous);
}

/** 歌词宿主在原生排版与字体测量完成前保持隐藏；截图前等它就绪。 */
export async function waitForLyrics(root: HTMLElement, expectedHosts = 1) {
  await waitFor(() => {
    const hosts = [...root.querySelectorAll<HTMLElement>(".baka-lyric-host:not([hidden])")];
    if (hosts.length !== expectedHosts) throw new Error(`歌词宿主数量错误：期望 ${expectedHosts}，实际 ${hosts.length}`);
    if (hosts.some((host) => host.dataset.ready !== "true")) throw new Error("歌词尚未完成排版");
  }, { timeout: 10_000 });
}
// ==================== 聊天 ====================

/** 一段猜歌房的聊天：系统提示、本人与他人消息、@提及与长文本换行。 */
export function songChat({ playing = false }: { playing?: boolean } = {}): ChatMessage[] {
  const system = (text: string, at: number) => ({ playerId: "", playerName: "", text, at, system: true });
  const say = (person: Person, text: string, at: number) => ({ playerId: person.id, playerName: person.name, text, at, system: false });
  const entries = [
    system(`${HOST.name} 创建了房间`, 0),
    system(`${ME.name} 加入了房间`, 9),
    system(`${PEACH.name} 加入了房间`, 15),
    say(HOST, "今晚主题随意，出题别太冷门哈", 22),
    say(ME, `@${HOST.name} 收到，我准备好了`, 30),
    say(PEACH, "我出一首夏天的歌，前奏一响应该就有人知道", 41),
    say(AZUMI, "上一轮那首我听了三遍副歌都没想起来是谁唱的，这次一定要把年份和语种的提示都看仔细一点再猜", 55),
    ...(playing ? [
      system("第 3 轮开始", 70),
      say(LONG, "这个前奏好耳熟", 78),
      say(ME, "歌词里有ソーダ，应该是夏天的歌", 86),
    ] : []),
  ];
  return entries.map(({ at, ...entry }, index) => ({ id: `song-chat-${index + 1}`, createdAt: STORY_EPOCH + at * 1000, ...entry }));
}

// ==================== 歌曲 ====================

const cover = (label: string, hue: number) => placeholderImage(label, hue, 160, 160);

export const SONG_ANSWER: SongSearchResult = {
  id: "song-tsukimi-soda", title: "月見ソーダ", artist: "夜行ラジオ", album: "夏の終わりの放送室",
  pictureUrl: cover("月", 205), durationMs: 214_000, popularity: 128_400,
};
export const SONG_EVENING: SongSearchResult = {
  id: "song-evening-wind", title: "晚风与你", artist: "陈屿", album: "日落前的车站",
  pictureUrl: cover("风", 25), durationMs: 236_000, popularity: 56_200,
};
export const SONG_GLASS: SongSearchResult = {
  id: "song-glass-constellation", title: "硝子の星座", artist: "水无月乐团", album: "夜想航路",
  pictureUrl: cover("星", 265), durationMs: 251_000, popularity: 312_000, requiresVip: true,
};
export const SONG_RAIN: SongSearchResult = {
  id: "song-rainy-platform", title: "雨の日のプラットホーム", artist: "夜行ラジオ", album: "夏の終わりの放送室",
  pictureUrl: cover("雨", 185), durationMs: 198_000, popularity: 42_000,
};
export const SONG_BLUE: SongSearchResult = {
  id: "song-blue-letter", title: "蓝色信笺", artist: "林间小径", durationMs: 227_000, popularity: 8_300,
};
export const SONG_LONG: SongSearchResult = {
  id: "song-long-title", title: "在海风吹过的第七个夏天里我们终于学会了告别", artist: "北岸电台 / 苏木",
  album: "潮汐时刻表", pictureUrl: cover("潮", 160), durationMs: 289_000, popularity: 3_100,
};

export const SONG_SEARCH_RESULTS: SongSearchResult[] = [SONG_ANSWER, SONG_RAIN, SONG_GLASS, SONG_EVENING, SONG_BLUE, SONG_LONG];

type RevealedSong = SonGuessrRoundSummary["song"];

export const SONG_ANSWER_DETAILS: RevealedSong = {
  ...SONG_ANSWER, releaseYear: 2021, language: "日语",
  encyclopedia: {
    tags: ["J-Pop", "City Pop", "夏日"], aliases: ["Tsukimi Soda"],
    summary: "收录于乐队首张专辑，描写夏夜散步时的心情。副歌部分在短视频平台流行后被大量翻唱。",
  },
  chorus: { startTime: 57_000, endTime: 83_000 },
};

export const SONG_EVENING_DETAILS: RevealedSong = {
  ...SONG_EVENING, releaseYear: 2019, language: "国语",
  encyclopedia: { tags: ["华语流行", "民谣"], summary: "以吉他与口琴为主的轻快民谣，讲述傍晚在海边车站等人的片刻。" },
  chorus: { startTime: 64_000, endTime: 88_000 },
};
// ==================== 猜测记录 ====================

export function songAttempt(
  person: Person,
  guessNumber: number,
  offsetSeconds: number,
  result: SongGuessAttempt["result"],
  extra: Partial<SongGuessAttempt> = {},
): SongGuessAttempt {
  return {
    id: `attempt-${person.id}-${guessNumber}`, playerId: person.id, playerName: person.name, guessNumber,
    createdAt: STORY_EPOCH + (70 + offsetSeconds) * 1000, result, ...extra,
  };
}

/** 第 3 轮：海豹猜错 → 小布丁猜中 → 阿澄连错并超时 → 长名字玩家猜中 → 海豹投降（仅结算后出现）。 */
export const SONG_ATTEMPTS = {
  meWrong: songAttempt(ME, 1, 8, "wrong", {
    guessedSong: SONG_EVENING,
    feedback: { releaseYear: 2019, releaseYearDirection: "higher", popularity: 56_200, popularityDirection: "higher", languageMatch: false, sharedTags: [] },
  }),
  hostCorrect: songAttempt(HOST, 1, 12, "correct", {
    guessedSong: SONG_ANSWER,
    feedback: { releaseYear: 2021, releaseYearDirection: "equal", popularity: 128_400, popularityDirection: "equal", languageMatch: true, sharedTags: ["J-Pop", "City Pop", "夏日"] },
  }),
  azumiWrong: songAttempt(AZUMI, 1, 14, "wrong", {
    guessedSong: SONG_RAIN,
    feedback: { releaseYear: 2021, releaseYearDirection: "equal", popularity: 42_000, popularityDirection: "higher", languageMatch: true, sharedTags: ["J-Pop"] },
  }),
  longCorrect: songAttempt(LONG, 1, 17, "correct", {
    guessedSong: SONG_ANSWER,
    feedback: { releaseYear: 2021, releaseYearDirection: "equal", popularity: 128_400, popularityDirection: "equal", languageMatch: true, sharedTags: ["J-Pop", "City Pop", "夏日"] },
  }),
  azumiTimeout: songAttempt(AZUMI, 2, 75, "timeout"),
  azumiLast: songAttempt(AZUMI, 3, 81, "wrong", {
    guessedSong: SONG_GLASS,
    feedback: { releaseYear: 2023, releaseYearDirection: "lower", popularity: 312_000, popularityDirection: "lower", sharedTags: [] },
  }),
  meGaveUp: songAttempt(ME, 2, 90, "gaveUp"),
};

const { meWrong, hostCorrect, azumiWrong, longCorrect, azumiTimeout, azumiLast, meGaveUp } = SONG_ATTEMPTS;
/** 进行中全房可见的记录（出题人与旁观者视角）。 */
export const SONG_ROOM_ATTEMPTS = [meWrong, hostCorrect, azumiWrong, longCorrect, azumiTimeout, azumiLast];

// ==================== 歌词 ====================

type LyricSource = { time: number; endTime: number; phrases: string[]; translatedLyric: string; romanLyric: string };

const ANSWER_LYRICS: LyricSource[] = [
  { time: 58_000, endTime: 62_600, phrases: ["改札を", "抜けて ", "夜風が", "頬を", "撫でる"], translatedLyric: "穿过检票口 晚风轻抚脸颊", romanLyric: "kaisatsu wo nukete yokaze ga hoho wo naderu" },
  { time: 63_000, endTime: 67_400, phrases: ["コンビニの", "灯りに", "ふたり分の", "影"], translatedLyric: "便利店的灯光下 映着两个人的影子", romanLyric: "konbini no akari ni futaribun no kage" },
  { time: 67_800, endTime: 72_300, phrases: ["溶けかけた", "アイスと", "言えない", "ことば"], translatedLyric: "快要融化的冰淇淋 和说不出口的话", romanLyric: "tokekaketa aisu to ienai kotoba" },
  { time: 72_800, endTime: 77_200, phrases: ["見上げた", "空に", "月が", "ひとつ"], translatedLyric: "抬头望向夜空 只有一轮明月", romanLyric: "miageta sora ni tsuki ga hitotsu" },
  { time: 77_600, endTime: 82_000, phrases: ["ソーダの", "泡みたいに", "ほどけてく"], translatedLyric: "像汽水的泡沫一样 慢慢化开", romanLyric: "sooda no awa mitai ni hodoketeku" },
];

/** 把一句歌词按词组平均切成逐字时间轴，和网易云 YRC 的结构一致。 */
function lyricLine({ time, endTime, phrases }: LyricSource, extra: Partial<SongLyricLine> = {}): SongLyricLine {
  const step = (endTime - time) / phrases.length;
  return {
    time, endTime, text: phrases.join(""),
    words: phrases.map((word, index) => ({ startTime: Math.round(time + step * index), endTime: Math.round(time + step * (index + 1)), word })),
    ...extra,
  };
}

/** 题目片段：前后各延展 1 秒。`roman` 为无翻译只显示注音，`harmony` 附带和声行。 */
export function songLyricClip(variant: "translated" | "roman" | "harmony" | "plain" = "translated"): SongLyricClip {
  const lines = ANSWER_LYRICS.flatMap((source, index) => {
    const main = lyricLine(source, variant === "translated" ? { translatedLyric: source.translatedLyric }
      : variant === "roman" ? { romanLyric: source.romanLyric } : {});
    if (variant !== "harmony" || index % 2 === 1) return [main];
    return [main, { time: source.time + 1_200, endTime: source.endTime - 300, text: "（夏の夜に）", isBG: true }];
  });
  return { startTime: 57_000, endTime: 83_000, lines };
}

const EVENING_LYRICS: LyricSource[] = [
  { time: 65_000, endTime: 69_200, phrases: ["晚风吹过", "站台的", "长椅"], translatedLyric: "", romanLyric: "" },
  { time: 69_600, endTime: 73_800, phrases: ["你说", "再等一班", "就回去"], translatedLyric: "", romanLyric: "" },
  { time: 74_200, endTime: 78_400, phrases: ["海面上的光", "一点点", "暗下去"], translatedLyric: "", romanLyric: "" },
  { time: 78_800, endTime: 83_000, phrases: ["我们都", "没有", "说再见"], translatedLyric: "", romanLyric: "" },
  { time: 83_400, endTime: 87_600, phrases: ["只是把", "这一刻", "记起"], translatedLyric: "", romanLyric: "" },
];

export const SONG_EVENING_CLIP: SongLyricClip = { startTime: 64_000, endTime: 88_600, lines: EVENING_LYRICS.map((source) => lyricLine(source)) };
// ==================== 番剧 ====================

const poster = (label: string, hue: number) => placeholderImage(label, hue, 80, 112);

export const ANIME_ANSWER: BangumiSubjectSearchResult = {
  id: "subject-summer-sky", name: "夏空メロディー", nameCn: "夏空旋律", imageUrl: poster("夏", 200),
  year: 2021, rating: 7.8, ratingCount: 5_234, tags: ["原创", "音乐", "青春", "校园", "日常", "治愈"], metaTags: ["TV"],
};

export const ANIME_SEARCH_RESULTS: BangumiSubjectSearchResult[] = [
  ANIME_ANSWER,
  { id: "subject-star-voyage", name: "星屑のボヤージュ", nameCn: "星屑航行", imageUrl: poster("星", 250), year: 2019, rating: 7.2, tags: ["科幻", "冒险"], metaTags: ["TV"] },
  { id: "subject-afterschool-band", name: "放課後バンドノート", nameCn: "放学后乐队笔记", year: 2022, rating: 8.1, tags: ["音乐", "乐队"], metaTags: ["TV"] },
  { id: "subject-sea-tram", name: "潮風トラム", nameCn: "", imageUrl: poster("潮", 170), year: 2018, tags: ["日常"], metaTags: ["剧场版"] },
];

export const ANIME_TRACK: BangumiMusicTrack = { title: "夏空メロディー", artist: "コトノハ", kind: "opening" };

/** 出题时选中《夏空旋律》后匹配到的关联曲：OP、ED 与一首插曲。 */
export const ANIME_SONG_CANDIDATES: BangumiSongCandidate[] = [
  { track: ANIME_TRACK, song: { id: "song-summer-sky-op", title: "夏空メロディー", artist: "コトノハ", album: "TVアニメ「夏空メロディー」オープニングテーマ", pictureUrl: cover("空", 195) } },
  { track: { title: "またね、ひこうき雲", artist: "葉月ゆら", kind: "ending" }, song: { id: "song-summer-sky-ed", title: "またね、ひこうき雲", artist: "葉月ゆら", album: "夏空メロディー ED", pictureUrl: cover("雲", 30) } },
  { track: { title: "放課後サイダー", artist: "コトノハ", kind: "insert" }, song: { id: "song-summer-sky-in", title: "放課後サイダー", artist: "コトノハ", requiresVip: true } },
];

export const ANIME_SONG_DETAILS: RevealedSong = {
  id: "song-summer-sky-op", title: "夏空メロディー", artist: "コトノハ", album: "TVアニメ「夏空メロディー」オープニングテーマ",
  pictureUrl: cover("空", 195), durationMs: 241_000, popularity: 86_500, releaseYear: 2021, language: "日语",
  encyclopedia: { tags: ["ACG", "J-Pop"] },
};

// ==================== 结算 ====================

function score(person: Person, value: number, delta: number, correctGuesses: number, totalGuesses: number): SonGuessrScore {
  return { playerId: person.id, playerName: person.name, score: value, delta, correctGuesses, totalGuesses };
}

/** 第 3 轮后：小布丁、长名字玩家各猜中 +1，出题人桃子按猜中人数 +6。 */
export const SONG_ROUND_SCORES: SonGuessrScore[] = [
  score(PEACH, 9, 6, 1, 2),
  score(HOST, 5, 1, 2, 4),
  score(ME, 4, 0, 1, 2),
  score(LONG, 3, 1, 1, 3),
  score(AZUMI, 2, 0, 1, 6),
  score(KANADE, 1, 0, 0, 3),
];

export function songRoundSummary(overrides: Partial<SonGuessrRoundSummary> = {}): SonGuessrRoundSummary {
  return {
    roundNumber: 3, song: SONG_ANSWER_DETAILS, submitterPlayerId: PEACH.id, correctPlayerIds: [HOST.id, LONG.id],
    attempts: [...SONG_ROOM_ATTEMPTS, meGaveUp], scores: SONG_ROUND_SCORES, ...overrides,
  };
}

export function animeRoundSummary(overrides: Partial<SonGuessrRoundSummary> = {}): SonGuessrRoundSummary {
  return songRoundSummary({ song: ANIME_SONG_DETAILS, anime: ANIME_ANSWER, animeTrack: ANIME_TRACK, attempts: [], ...overrides });
}

// ==================== 玩家名单 ====================

/** 新开的房间：房主默认已准备，阿澄尚未准备，Kanade 断线。 */
export function waitingPlayers(): SonGuessrPlayerView[] {
  return [
    songPlayer(HOST, { isReady: true }),
    songPlayer(ME, { isReady: true }),
    songPlayer(PEACH, { isReady: true }),
    songPlayer(AZUMI),
    songPlayer(KANADE, { isReady: true, online: false }),
    songPlayer(LONG, { isReady: true }),
    songPlayer(PASSERBY, { membership: "spectator", roundStatus: "spectator" }),
  ];
}

/** 第 2 轮结束后、第 3 轮开始前的名单。 */
export function betweenRoundPlayers(): SonGuessrPlayerView[] {
  return [
    songPlayer(HOST, { isReady: true, score: 4, correctGuesses: 1, totalGuesses: 3 }),
    songPlayer(ME, { isReady: true, score: 4, correctGuesses: 1, totalGuesses: 1 }),
    songPlayer(PEACH, { isReady: true, score: 3, correctGuesses: 1, totalGuesses: 2 }),
    songPlayer(AZUMI, { isReady: true, score: 2, correctGuesses: 1, totalGuesses: 3 }),
    songPlayer(KANADE, { isReady: true, score: 1, totalGuesses: 3 }),
    songPlayer(LONG, { isReady: true, score: 2, totalGuesses: 2 }),
    songPlayer(PASSERBY, { membership: "spectator", roundStatus: "spectator" }),
  ];
}

/** 第 3 轮进行中：覆盖出题、猜歌、猜中、完成、断线与旁观。 */
export function playingPlayers(): SonGuessrPlayerView[] {
  return [
    songPlayer(HOST, { isReady: true, score: 5, correctGuesses: 2, totalGuesses: 4, roundStatus: "correct", guessesUsed: 1 }),
    songPlayer(ME, { isReady: true, score: 4, correctGuesses: 1, totalGuesses: 2, roundStatus: "guessing", guessesUsed: 1 }),
    songPlayer(PEACH, { isReady: true, score: 3, correctGuesses: 1, totalGuesses: 2, roundStatus: "submitter" }),
    songPlayer(AZUMI, { isReady: true, score: 2, correctGuesses: 1, totalGuesses: 6, roundStatus: "finished", guessesUsed: 3 }),
    songPlayer(KANADE, { isReady: true, score: 1, totalGuesses: 3, online: false, roundStatus: "guessing" }),
    songPlayer(LONG, { isReady: true, score: 3, correctGuesses: 1, totalGuesses: 3, roundStatus: "correct", guessesUsed: 1 }),
    songPlayer(PASSERBY, { membership: "spectator", roundStatus: "spectator" }),
  ];
}

/** 第 3 轮结算：分数与 `SONG_ROUND_SCORES` 一致，海豹已投降。 */
export function roundResultPlayers(): SonGuessrPlayerView[] {
  const byId = new Map(SONG_ROUND_SCORES.map((entry) => [entry.playerId, entry.score]));
  return playingPlayers().map((player) => ({
    ...player,
    score: byId.get(player.id) ?? player.score,
    ...(player.id === ME.id || player.id === KANADE.id ? { roundStatus: "finished" as const } : {}),
  }));
}
// ==================== 各阶段快照 ====================

type SnapshotPatch = Partial<SonGuessrRoomSnapshot>;

export const choosingSnapshot = (overrides: SnapshotPatch = {}) =>
  songSnapshot({ phase: "choosingSubmitter", roundNumber: 2, players: betweenRoundPlayers(), ...overrides });

export const submittingSnapshot = (overrides: SnapshotPatch = {}) =>
  songSnapshot({ phase: "submittingSong", roundNumber: 2, pendingSubmitterPlayerId: PEACH.id, players: betweenRoundPlayers(), ...overrides });

/**
 * 第 3 轮进行中。`audioUrl` 故意为空：播放器不加载任何媒体，截图不依赖外网与浏览器自动播放策略，
 * 音频按钮停在“加载中”（与“播放中”同一个转圈图标）。就绪、重播、失败态由阶段组件故事通过属性覆盖。
 */
export const playingSnapshot = (overrides: SnapshotPatch = {}) =>
  songSnapshot({
    phase: "playing", roundNumber: 3, players: playingPlayers(), chat: songChat({ playing: true }),
    currentRound: { roundNumber: 3, submitterPlayerId: PEACH.id, audioUrl: "", lyricClip: songLyricClip() },
    ...overrides,
  });

export const roundResultSnapshot = (overrides: SnapshotPatch = {}) =>
  songSnapshot({
    phase: "roundResult", roundNumber: 3, players: roundResultPlayers(), chat: songChat({ playing: true }),
    roundSummary: songRoundSummary(), ...overrides,
  });

type PrivatePatch = Partial<SonGuessrPrivateState>;

/** 猜歌玩家视角：已猜错一次、剩 2 次。截止时间由故事在运行时用 `fromNow` 计算。 */
export const guesserPrivate = (guessDeadlineAt: number, overrides: PrivatePatch = {}) =>
  songPrivate({ canGuess: true, canGiveUp: true, remainingGuesses: 2, guessDeadlineAt, visibleAttempts: [meWrong], ...overrides });

export const submitterPrivate = (overrides: PrivatePatch = {}) =>
  songPrivate({ playerId: PEACH.id, isSubmitter: true, submittedSong: SONG_ANSWER, visibleAttempts: SONG_ROOM_ATTEMPTS, ...overrides });

export const spectatorPrivate = (overrides: PrivatePatch = {}) =>
  songPrivate({ playerId: PASSERBY.id, submittedSong: SONG_ANSWER, visibleAttempts: SONG_ROOM_ATTEMPTS, ...overrides });

// ==================== 单人模式 ====================

export const soloPlayer = (overrides: Partial<SonGuessrPlayerView> = {}) => songPlayer(ME, { isReady: true, ...overrides });

/** 单人房由系统自动出题，没有出题人（服务端以空字符串占位）。 */
export const soloSnapshot = (overrides: SnapshotPatch = {}) =>
  songSnapshot({
    roomId: SONG_SOLO_ROOM_ID, name: "单人模式", solo: true, allowSpectators: false, hostPlayerId: ME.id,
    settings: songSettings({ questionMode: "automatic" }), players: [soloPlayer()], chat: [], ...overrides,
  });

export const soloPlayingSnapshot = (overrides: SnapshotPatch = {}) =>
  soloSnapshot({
    phase: "playing", roundNumber: 3, players: [soloPlayer({ score: 1, correctGuesses: 1, totalGuesses: 3, roundStatus: "guessing" })],
    currentRound: { roundNumber: 3, submitterPlayerId: "", audioUrl: "", lyricClip: SONG_EVENING_CLIP }, ...overrides,
  });

export const soloResultSnapshot = (overrides: SnapshotPatch = {}) =>
  soloSnapshot({
    phase: "roundResult", roundNumber: 3,
    players: [soloPlayer({ score: 2, correctGuesses: 2, totalGuesses: 4, roundStatus: "correct", guessesUsed: 1 })],
    roundSummary: songRoundSummary({
      song: SONG_EVENING_DETAILS, submitterPlayerId: "", correctPlayerIds: [ME.id], attempts: [], scores: [score(ME, 2, 1, 2, 4)],
    }),
    ...overrides,
  });

/** 单人页从会话存储读取房间号，与快照房间号一致时直接进入，不会新建房间。 */
export function seedSoloRoom() {
  saveSongSoloRoomId(SONG_SOLO_ROOM_ID);
  return () => clearSongSoloRoomId();
}
// ==================== 大厅 ====================

function lobbyRoom(roomId: string, name: string, overrides: Partial<SonGuessrRoomSummary> = {}): SonGuessrRoomSummary {
  const room: SonGuessrRoomSummary = {
    roomId, name, visibility: "public", allowSpectators: true, hasPassword: false,
    playerCount: 2, spectatorCount: 0, onlineCount: 2, phase: "waiting", questionType: "song", ...overrides,
  };
  return { ...room, onlineCount: room.playerCount + room.spectatorCount };
}

/** 覆盖等待中 / 游戏中 / 结算中、有无密码、可否观战、满员与超长房间名。 */
export const SONG_LOBBY_ROOMS: SonGuessrRoomSummary[] = [
  lobbyRoom(SONG_ROOM_ID, `${HOST.name}的房间`, { playerCount: 6, spectatorCount: 1 }),
  lobbyRoom("2718", "周五夜听歌会", { phase: "playing", visibility: "private", hasPassword: true, playerCount: 5, spectatorCount: 3 }),
  lobbyRoom("3141", "动画主题曲专场", { phase: "roundResult", questionType: "anime", playerCount: 4, spectatorCount: 2 }),
  lobbyRoom("5920", "只听华语老歌", { allowSpectators: false, playerCount: 3 }),
  lobbyRoom("8086", "名称很长的房间用于检查截断：周末一起猜一猜那些年单曲循环过的歌", { phase: "submittingSong", playerCount: 12, spectatorCount: 10 }),
];

// ==================== 网易云账号 ====================

export const SONG_ACCOUNTS = {
  vip: {
    userId: "10001", nickname: "夜行电台的听众", avatarUrl: placeholderImage("听", 30, 80, 80),
    vipStatus: "vip", vipType: 11, vipExpireTime: Date.UTC(2027, 2, 31, 16, 0, 0),
  },
  nonVip: { userId: "10002", nickname: "海豹的歌单", vipStatus: "nonVip" },
  unknown: { userId: "10003", nickname: "小布丁", vipStatus: "unknown" },
} satisfies Record<string, SonGuessrMusicAccount>;

/** 本机登录状态只存在浏览器存储里；Cookie 为占位值，不会发往任何服务。 */
export function seedMusicSession(account: SonGuessrMusicAccount) {
  saveSongMusicSession({ cookie: "MUSIC_U=story-placeholder", account }, true);
  return () => clearStoredSongMusicSession();
}


/** 固定图案的二维码占位图：带三个定位角，外观接近真实登录二维码但不可扫描。 */
function qrPlaceholder(): string {
  const size = 25;
  let seed = 20260927;
  const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const finder = (x: number, y: number) => {
    for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      const dx = x - ox;
      const dy = y - oy;
      if (dx >= -1 && dx <= 7 && dy >= -1 && dy <= 7) {
        if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return false;
        return dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
      }
    }
    return null;
  };
  let cells = "";
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const fixed = finder(x, y);
      if (fixed ?? next() < 0.48) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${size + 4} ${size + 4}" shape-rendering="crispEdges">`
    + `<rect x="-2" y="-2" width="${size + 4}" height="${size + 4}" fill="#fff"/><g fill="#1f1a17">${cells}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const SONG_QR = { key: "story-qr-key", qrUrl: "https://music.163.com/login?codekey=story-qr-key", qrImage: qrPlaceholder() };
