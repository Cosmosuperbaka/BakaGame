import type {
  CEEAppearance,
  CEECharacterView,
  CEEFeedback,
  CEEFeedbackValue,
  CEESpectateRequest,
  CEEGuess,
  CEEPlayer,
  CEEPrivateState,
  CEERoomSnapshot,
  CEERoomSummary,
  CEERoundSummary,
  CEEScoreDetail,
  CEESettings,
  ChatMessage,
} from "@bakagame/shared";
import { createDefaultCEESettings } from "@bakagame/shared/values";
import { getSavedUsername, saveUsername } from "@/lib/Storage";
import { fromNow, placeholderImage, STORY_EPOCH, STORY_PLAYERS, STORY_SPECTATORS } from "./Common";

// ==================== CEE 故事假数据 ====================
// 只供 Storybook 与截图使用，不被应用代码导入。角色资料按 Bangumi 口径编写，
// 猜测反馈按服务端 buildCEEFeedback 的规则推导；图片均为数据 URL，CEECharacterImage 不会回源请求。

/** 与 STORY_EPOCH 同年，默认设置的年份区间因此固定为 2021—2026。 */
const STORY_YEAR = new Date(STORY_EPOCH).getUTCFullYear();

export const CEE_NATIVE_ROOM_ID = "1234";
export const CEE_ORIGINAL_ROOM_ID = "5821";
export const CEE_SESSION_TOKEN = "story-cee-session";

type Member = { id: string; name: string };
const [HOST, ME, PEACH, AZUMI, KANADE, KITAGAWA, LONG] = STORY_PLAYERS;
const [PASSERBY] = STORY_SPECTATORS;
/** 增强房固定座次：前六位参与猜题，路人甲旁观。 */
const SEATED = [HOST, ME, PEACH, AZUMI, KANADE, LONG, PASSERBY];

export const ceeSettings = (patch: Partial<CEESettings> = {}): CEESettings => ({
  ...createDefaultCEESettings(STORY_YEAR),
  ...patch,
});

/** 大厅与入房弹窗读取本机上次使用的用户名；故事结束时还原，不改动开发者自己的记录。 */
export function presetSavedUsername(name: string = ME.name) {
  const previous = getSavedUsername();
  saveUsername(name);
  return () => saveUsername(previous);
}

// ==================== 作品与角色 ====================

const work = (
  id: number,
  nameCn: string,
  name: string,
  year: number,
  rating: number,
  ratingCount: number
): CEEAppearance => ({ id, name, nameCn, year, rating, ratingCount });

const BOCCHI = [
  work(328609, "孤独摇滚！", "ぼっち・ざ・ろっく！", 2022, 8.9, 31250),
  work(446158, "剧场总集篇 孤独摇滚！ Re:", "劇場総集編ぼっち・ざ・ろっく！ Re:", 2024, 8.4, 3120),
  work(
    446159,
    "剧场总集篇 孤独摇滚！ Re:Re:",
    "劇場総集編ぼっち・ざ・ろっく！ Re:Re:",
    2024,
    8.5,
    2890
  ),
];
const KEION = [
  work(1424, "轻音少女", "けいおん！", 2009, 7.9, 18500),
  work(1425, "轻音少女 第二季", "けいおん！！", 2010, 8.3, 16200),
  work(8765, "轻音少女 Live House!", "けいおん！ ライブハウス！", 2010, 7.6, 4200),
  work(24640, "轻音少女 第二季 番外篇", "けいおん！！ 番外編", 2011, 7.8, 3900),
  work(8900, "轻音少女 剧场版", "映画けいおん！", 2011, 8.2, 9800),
];
const JUJUTSU = [
  work(294993, "咒术回战", "呪術廻戦", 2020, 7.6, 21300),
  work(369304, "咒术回战 第二季", "呪術廻戦 懐玉・玉折／渋谷事変", 2023, 8.1, 14600),
  work(346001, "剧场版 咒术回战 0", "劇場版 呪術廻戦 0", 2021, 7.7, 8800),
];

const BOCCHI_TAGS = ["音乐", "乐队", "漫画改", "搞笑"];
const KEION_TAGS = ["音乐", "京阿尼", "日常", "治愈"];
const JUJUTSU_TAGS = ["战斗", "漫画改", "奇幻", "热血"];

interface CharacterSeed {
  id: number;
  nameCn: string;
  name: string;
  label: string;
  hue: number;
  gender?: CEECharacterView["gender"];
  popularity: number;
  works: CEEAppearance[];
  subjectTags: string[];
  characterTags: string[];
  voiceActors: string[];
  metaTags: string[];
  summary?: string;
}

/** 按服务端角色视图的口径派生年份、最高评分与比对作品，保证反馈表与答案卡互相吻合。 */
function character(seed: CharacterSeed): CEECharacterView {
  const years = seed.works.map((entry) => entry.year);
  return {
    id: seed.id,
    name: seed.name,
    nameCn: seed.nameCn,
    imageUrl: placeholderImage(seed.label, seed.hue),
    gender: seed.gender ?? "female",
    popularity: seed.popularity,
    summary: seed.summary ?? "",
    appearances: seed.works,
    highestRating: Math.max(...seed.works.map((entry) => entry.rating)),
    earliestAppearance: Math.min(...years),
    latestAppearance: Math.max(...years),
    subjectTags: seed.subjectTags,
    characterTags: seed.characterTags,
    voiceActors: seed.voiceActors,
    metaTags: seed.metaTags,
    comparisonAppearances: seed.works.map(({ id, name, nameCn }) => ({ id, name, nameCn })),
    extraTags: [],
  };
}

export const CEE_CHARACTERS = {
  nijika: character({
    id: 263457,
    nameCn: "伊地知虹夏",
    name: "伊地知虹夏",
    label: "虹夏",
    hue: 48,
    popularity: 6800,
    works: BOCCHI,
    subjectTags: BOCCHI_TAGS,
    characterTags: ["金发", "侧马尾", "呆毛", "鼓手", "高中生", "元气"],
    voiceActors: ["铃代纱弓"],
    metaTags: ["TV", "漫画改", "音乐"],
    summary:
      "下北泽高中二年级学生，结束乐队的鼓手兼队长。性格开朗、很会照顾人，是乐队里调和气氛的存在。梦想是让乐队站上更大的舞台。",
  }),
  hitori: character({
    id: 263456,
    nameCn: "后藤一里",
    name: "後藤ひとり",
    label: "一里",
    hue: 330,
    popularity: 15800,
    works: BOCCHI,
    subjectTags: BOCCHI_TAGS,
    characterTags: ["粉发", "社恐", "吉他手", "高中生", "运动服"],
    voiceActors: ["青山吉能"],
    metaTags: ["TV", "漫画改", "音乐"],
  }),
  ryo: character({
    id: 263458,
    nameCn: "山田凉",
    name: "山田リョウ",
    label: "凉",
    hue: 215,
    popularity: 9800,
    works: BOCCHI,
    subjectTags: BOCCHI_TAGS,
    characterTags: ["蓝发", "三无", "贝斯手", "高中生", "怪人"],
    voiceActors: ["水野朔"],
    metaTags: ["TV", "漫画改", "音乐"],
  }),
  ikuyo: character({
    id: 263459,
    nameCn: "喜多郁代",
    name: "喜多郁代",
    label: "郁代",
    hue: 8,
    popularity: 7100,
    works: BOCCHI,
    subjectTags: BOCCHI_TAGS,
    characterTags: ["红发", "现充", "吉他手", "高中生", "元气"],
    voiceActors: ["长谷川育美"],
    metaTags: ["TV", "漫画改", "音乐"],
  }),
  kikuri: character({
    id: 263460,
    nameCn: "广井菊里",
    name: "廣井きくり",
    label: "菊里",
    hue: 285,
    popularity: 3900,
    works: BOCCHI,
    subjectTags: BOCCHI_TAGS,
    characterTags: ["紫发", "酒鬼", "贝斯手", "成年人"],
    voiceActors: ["千本木彩花"],
    metaTags: ["TV", "漫画改", "音乐"],
  }),
  yui: character({
    id: 12467,
    nameCn: "平泽唯",
    name: "平沢唯",
    label: "唯",
    hue: 30,
    popularity: 7900,
    works: KEION,
    subjectTags: KEION_TAGS,
    characterTags: ["棕发", "天然呆", "吉他手", "高中生"],
    voiceActors: ["丰崎爱生"],
    metaTags: ["TV", "漫画改", "音乐"],
  }),
  mio: character({
    id: 12468,
    nameCn: "秋山澪",
    name: "秋山澪",
    label: "澪",
    hue: 235,
    popularity: 11200,
    works: KEION,
    subjectTags: KEION_TAGS,
    characterTags: ["黑长直", "害羞", "贝斯手", "高中生"],
    voiceActors: ["日笠阳子"],
    metaTags: ["TV", "漫画改", "音乐"],
  }),
  gojo: character({
    id: 164371,
    nameCn: "五条悟",
    name: "五条悟",
    label: "五条",
    hue: 195,
    gender: "male",
    popularity: 18400,
    works: JUJUTSU,
    subjectTags: JUJUTSU_TAGS,
    characterTags: ["白发", "眼罩", "最强", "教师"],
    voiceActors: ["中村悠一"],
    metaTags: ["TV", "漫画改", "战斗"],
  }),
} satisfies Record<string, CEECharacterView>;
export type CEECharacterKey = keyof typeof CEE_CHARACTERS;

/** 服务端从答案简介截取的自动文本提示。 */
const NIJIKA_HINTS = ["……结束乐队的鼓手兼队长……", "……梦想是让乐队站上更大的舞台……"];

// ==================== 猜测反馈 ====================

/** 与服务端 compareNumber 相同：符号表示「猜测值减答案值」。 */
function compare(value: number, answer: number, equal: number, near: number): CEEFeedbackValue {
  const diff = value - answer;
  const comparison =
    Math.abs(diff) <= equal
      ? "="
      : diff > 0
        ? diff <= near
          ? "+"
          : "++"
        : diff >= -near
          ? "-"
          : "--";
  return { value, comparison };
}

export function ceeFeedback(
  guess: CEECharacterView,
  answer: CEECharacterView,
  settings: CEESettings
): CEEFeedback {
  const answerIds = new Set(answer.comparisonAppearances.map((entry) => entry.id));
  const tags: CEEFeedback["tags"] = [];
  const append = (
    values: string[],
    answers: string[],
    limit: number,
    kind: CEEFeedback["tags"][number]["kind"]
  ) => {
    const pool = new Set(answers);
    const selected = [
      ...values.filter((text) => pool.has(text)).slice(0, limit),
      ...values.filter((text) => !pool.has(text)),
    ].slice(0, limit);
    for (const text of selected)
      if (!tags.some((tag) => tag.text === text))
        tags.push({ text, matched: pool.has(text), hidden: false, kind });
  };
  append(guess.subjectTags, answer.subjectTags, settings.subjectTagNum, "subject");
  append(guess.characterTags, answer.characterTags, settings.characterTagNum, "character");
  append(guess.voiceActors, answer.voiceActors, Number.POSITIVE_INFINITY, "voice");
  return {
    gender: { value: guess.gender, comparison: guess.gender === answer.gender ? "yes" : "no" },
    popularity: compare(
      guess.popularity,
      answer.popularity,
      answer.popularity * 0.05,
      answer.popularity * 0.2
    ),
    rating: compare(guess.highestRating, answer.highestRating, 0.3, 1),
    appearancesCount: compare(guess.appearances.length, answer.appearances.length, 0, 2),
    earliestAppearance: compare(guess.earliestAppearance, answer.earliestAppearance, 0, 2),
    latestAppearance: compare(guess.latestAppearance, answer.latestAppearance, 0, 2),
    sharedAppearances: guess.comparisonAppearances.filter((entry) => answerIds.has(entry.id)),
    tags,
    extraTags: [],
  };
}
export interface CEEGuessStep {
  player: Member;
  character: CEECharacterKey;
  at: number;
  syncRound?: number;
}

/** 一次猜测记录；`at` 为相对 STORY_EPOCH 的秒数，同时保证 id 唯一。 */
export function ceeGuess(
  step: CEEGuessStep,
  answer: CEECharacterKey,
  settings: CEESettings = ceeSettings()
): CEEGuess {
  const target = CEE_CHARACTERS[step.character];
  const feedback = ceeFeedback(target, CEE_CHARACTERS[answer], settings);
  const correct = step.character === answer;
  return {
    id: `guess-${step.player.id}-${step.at}`,
    playerId: step.player.id,
    playerName: step.player.name,
    character: {
      id: target.id,
      name: target.name,
      nameCn: target.nameCn,
      imageUrl: target.imageUrl,
    },
    correct,
    partial: !correct && feedback.sharedAppearances.length > 0,
    syncRound: step.syncRound ?? 1,
    createdAt: STORY_EPOCH + step.at * 1000,
    feedback,
  };
}

/** 标签全局 BP：已被其他玩家先发现的标签在本人视角隐藏（同服务端 visibleGuesses）。 */
function hideDiscoveredTags(guess: CEEGuess, discoveredByOthers: string[]): CEEGuess {
  return {
    ...guess,
    feedback: {
      ...guess.feedback,
      tags: guess.feedback.tags.map((tag) =>
        discoveredByOthers.includes(tag.text)
          ? { text: "???", matched: false, hidden: true, kind: tag.kind }
          : tag
      ),
    },
  };
}

// ==================== 房间状态 ====================

export function ceePlayer(member: Member, patch: Partial<CEEPlayer> = {}): CEEPlayer {
  return {
    id: member.id,
    name: member.name,
    online: true,
    ready: false,
    team: null,
    membership: "active",
    score: 0,
    status: "waiting",
    attempts: 0,
    marks: "",
    syncCompleted: false,
    ...patch,
  };
}

export function ceeSnapshot(patch: Partial<CEERoomSnapshot> = {}): CEERoomSnapshot {
  return {
    roomId: CEE_NATIVE_ROOM_ID,
    source: "native",
    name: "结束乐队应援团",
    visibility: "public",
    hasPassword: false,
    allowSpectators: true,
    bakaAntiCheat: false,
    hostPlayerId: HOST.id,
    phase: "waiting",
    settings: ceeSettings(),
    players: [],
    roundNumber: 0,
    syncRound: 0,
    setterPlayerId: null,
    phaseDeadlineAt: null,
    chat: [],
    roundSummary: null,
    upstreamConnected: true,
    spectateRequests: [],
    ...patch,
  };
}

export function ceePrivateState(patch: Partial<CEEPrivateState> = {}): CEEPrivateState {
  return {
    playerId: ME.id,
    canGuess: false,
    canSurrender: false,
    canStart: false,
    canSetAnswer: false,
    setterCandidateIds: [],
    guesses: [],
    answer: null,
    hints: [],
    imageHintAvailable: false,
    imageHintLevel: 0,
    deadlineAt: null,
    bannedCharacterIds: [],
    spectatePending: false,
    ...patch,
  };
}

const scoreLine = (member: Member, patch: Partial<CEEScoreDetail> = {}): CEEScoreDetail => ({
  playerId: member.id,
  playerName: member.name,
  score: 0,
  base: 0,
  firstGuess: 0,
  quickGuess: 0,
  partial: 0,
  setter: 0,
  reason: "",
  ...patch,
});

export function ceeRoundSummary(
  answer: CEECharacterKey,
  scores: CEEScoreDetail[],
  guesses: CEEGuess[]
): CEERoundSummary {
  return {
    answer: CEE_CHARACTERS[answer],
    scores,
    guesses,
    winners: scores.flatMap((line) =>
      line.rank ? [{ playerId: line.playerId, rank: line.rank, score: line.score }] : []
    ),
  };
}

let chatCounter = 0;
/** `member` 为 null 时是系统提示，文案取自服务端 CEERooms 的系统消息。 */
function chatLine(member: Member | null, text: string, at: number): ChatMessage {
  chatCounter += 1;
  return {
    id: `cee-chat-${chatCounter}`,
    playerId: member?.id ?? "",
    playerName: member?.name ?? "",
    text,
    createdAt: STORY_EPOCH + at * 1000,
    system: member === null,
  };
}
const joined = (members: Member[]) =>
  members.map((member, index) =>
    chatLine(
      null,
      index === 0 ? `${member.name} 创建了房间` : `${member.name} 加入了房间`,
      index * 6
    )
  );
// ==================== 大厅 ====================

const lobbyRoom = (
  roomId: string,
  name: string,
  phase: CEERoomSummary["phase"],
  playerCount: number,
  patch: Partial<CEERoomSummary> = {}
): CEERoomSummary => ({
  roomId,
  source: "native",
  name,
  phase,
  playerCount,
  spectatorCount: 0,
  hasPassword: false,
  allowSpectators: true,
  bakaAntiCheat: false,
  ...patch,
});

/** 两种来源混排，页面按当前标签过滤；覆盖全部阶段、带锁房间与超长房名。原版房不提供旁观人数。 */
export const CEE_LOBBY_ROOMS: CEERoomSummary[] = [
  lobbyRoom(CEE_NATIVE_ROOM_ID, "结束乐队应援团", "waiting", 7, { spectatorCount: 1 }),
  lobbyRoom("2718", "周末猜猜呗", "guessing", 5, { spectatorCount: 3 }),
  lobbyRoom("3306", "内部练习房", "waiting", 3, { hasPassword: true, allowSpectators: false }),
  lobbyRoom("4096", "老番享受者集合", "answering", 4),
  lobbyRoom("5173", "新人随便玩", "preparing", 2),
  lobbyRoom("6420", "名称很长的房间用于检查截断与右侧的阶段和人数信息不被挤出", "settled", 12, {
    spectatorCount: 8,
  }),
  lobbyRoom(CEE_ORIGINAL_ROOM_ID, "每日一猜", "waiting", 4, {
    source: "original",
    spectatorCount: null,
  }),
  lobbyRoom("7788", "小布丁的房间", "guessing", 9, { source: "original", spectatorCount: null }),
  lobbyRoom("9031", "瓶子严选", "waiting", 2, { source: "original", spectatorCount: null }),
];

// ==================== 房间场景 ====================

/** 一个房间视角：公开快照加上当前观看者的私有状态。 */
export interface CEERoomScenario {
  snapshot: CEERoomSnapshot;
  privateState: CEEPrivateState;
}

/** 打完两局后的累计积分。 */
const TOTALS: Record<string, number> = {
  [HOST.id]: 12,
  [ME.id]: 4,
  [PEACH.id]: 6,
  [AZUMI.id]: 2,
  [KANADE.id]: 2,
  [LONG.id]: 1,
};

/** 固定座次的玩家栏；`active` 作用于全部参与者，`patches` 按玩家覆盖。 */
function seated(
  patches: Record<string, Partial<CEEPlayer>> = {},
  active: Partial<CEEPlayer> = {}
): CEEPlayer[] {
  return SEATED.map((member) =>
    member === PASSERBY
      ? ceePlayer(member, { membership: "spectator", ...patches[member.id] })
      : ceePlayer(member, { score: TOTALS[member.id], ...active, ...patches[member.id] })
  );
}

/** 房主刚建好房间：桃子未准备，路人甲旁观；随机出题要等桃子准备好才能开始。候选名单只在选人阶段下发。 */
export function ceeWaitingHostRoom(settings: CEESettings = ceeSettings()): CEERoomScenario {
  return {
    snapshot: ceeSnapshot({
      settings,
      players: seated({ [PEACH.id]: { ready: false } }, { ready: true, score: 0 }),
      chat: [
        ...joined(SEATED),
        chatLine(HOST, "先用默认设置来一把，熟悉了再加难度", 50),
        chatLine(PEACH, "等我看一眼规则再准备", 58),
      ],
    }),
    privateState: ceePrivateState({ playerId: HOST.id }),
  };
}

/** 指定出题人模式下房主点了开始：旁观的路人甲排在推荐组，Kanade 断线不在候选里。 */
export function ceeChoosingSetterRoom(viewer: "host" | "guest"): CEERoomScenario {
  return {
    snapshot: ceeSnapshot({
      phase: "choosingSetter",
      roundNumber: 2,
      settings: ceeSettings({ answerMode: "manual" }),
      players: seated(
        { [KANADE.id]: { online: false }, [AZUMI.id]: { team: 1 }, [LONG.id]: { team: 1 } },
        { ready: true }
      ),
      chat: [...joined(SEATED), chatLine(HOST, "这局我来点一个人出题", 400)],
    }),
    privateState:
      viewer === "host"
        ? ceePrivateState({
            playerId: HOST.id,
            setterCandidateIds: SEATED.filter((member) => member !== KANADE).map(
              (member) => member.id
            ),
          })
        : ceePrivateState(),
  };
}

/** 设置弹窗里展示更多已开启的选项：文本与图片提示、角色全局 BP、追加作品。 */
export const CEE_CUSTOM_SETTINGS = ceeSettings({
  useHints: [8, 5],
  useImageHint: 6,
  globalPick: true,
  addedSubjects: [328609, 1424],
});
/** 打完两局回到等待：同步血战、不限时，已分好队；本人未准备，Kanade 断线。 */
export function ceeWaitingGuestRoom(): CEERoomScenario {
  return {
    snapshot: ceeSnapshot({
      roundNumber: 2,
      settings: ceeSettings({ syncMode: true, nonstopMode: true, maxAttempts: 8, timeLimit: 0 }),
      players: seated({
        [HOST.id]: { ready: true, team: 1 },
        [ME.id]: { team: 2 },
        [PEACH.id]: { ready: true, team: 1 },
        [AZUMI.id]: { ready: true, team: 2 },
        [KANADE.id]: { online: false },
        [LONG.id]: { ready: true },
      }),
      chat: [
        ...joined(SEATED),
        chatLine(HOST, "这把开同步血战，不限时间，慢慢猜", 400),
        chatLine(AZUMI, "我和海豹一队", 412),
      ],
    }),
    privateState: ceePrivateState(),
  };
}

/** 房主点了随机出题，服务端正在抽取角色；房主可以取消本局。 */
export function ceePreparingRoom(): CEERoomScenario {
  return {
    snapshot: ceeSnapshot({
      phase: "preparing",
      roundNumber: 2,
      phaseDeadlineAt: fromNow(24_000),
      players: seated({}, { ready: true }),
      chat: [...joined(SEATED), chatLine(HOST, "第三局随机出题，看看会抽到谁", 400)],
    }),
    privateState: ceePrivateState({ playerId: HOST.id }),
  };
}

/** 房主把自己指定为出题人：出题人看到选角与提示输入，其他人等待。 */
export function ceeAnsweringRoom(viewer: "setter" | "guesser"): CEERoomScenario {
  return {
    snapshot: ceeSnapshot({
      phase: "answering",
      roundNumber: 2,
      setterPlayerId: HOST.id,
      phaseDeadlineAt: fromNow(96_000),
      players: seated({ [ME.id]: { ready: false } }, { ready: true }),
      chat: [
        ...joined(SEATED),
        chatLine(HOST, "这局我来出题，给我两分钟", 400),
        chatLine(AZUMI, "别出太冷门的角色啊", 408),
      ],
    }),
    privateState:
      viewer === "setter"
        ? ceePrivateState({ playerId: HOST.id, canSetAnswer: true })
        : ceePrivateState(),
  };
}
/** 第 3 局答案为伊地知虹夏；开启标签全局 BP，剩余 8、6 次时解锁文本提示，剩余 6 次时解锁图片提示。 */
const GUESSING_SETTINGS = ceeSettings({ tagBan: true, useHints: [8, 6], useImageHint: 6 });
/** 按提交顺序排列：「乐队」「搞笑」由房主、「漫画改」由 Kanade 先发现，本人视角隐藏这三个标签。 */
const ROUND3: CEEGuessStep[] = [
  { player: ME, character: "yui", at: 38 },
  { player: KANADE, character: "gojo", at: 52 },
  { player: HOST, character: "yui", at: 60 },
  { player: PEACH, character: "mio", at: 71 },
  { player: HOST, character: "hitori", at: 76 },
  { player: ME, character: "kikuri", at: 88 },
  { player: KANADE, character: "yui", at: 104 },
  { player: PEACH, character: "yui", at: 118 },
  { player: ME, character: "ryo", at: 140 },
  { player: PEACH, character: "ikuyo", at: 166 },
  { player: ME, character: "ikuyo", at: 190 },
];

/** 普通模式猜测中：`player` 为本人（已用 4 次、提示已解锁），`spectator` 为旁观者（可见答案与全部猜测）。 */
/** 组队猜测：本人与阿澄同为 2 队，共用次数与进度；小布丁与桃子 1 队；其余个人游玩。 */
export function ceeTeamGuessingRoom(): CEERoomScenario {
  const scenario = ceeGuessingRoom("player");
  const team1 = { status: "playing" as const, attempts: 3, marks: "❌❌💡", team: 1 };
  const team2 = { status: "playing" as const, attempts: 4, marks: "❌💡💡💡", team: 2 };
  const players = scenario.snapshot.players.map((player) => ({
    ...player,
    ...(player.id === HOST.id || player.id === PEACH.id
      ? team1
      : player.id === ME.id || player.id === AZUMI.id
        ? team2
        : {}),
  }));
  return { ...scenario, snapshot: { ...scenario.snapshot, players } };
}

export function ceeGuessingRoom(viewer: "player" | "spectator"): CEERoomScenario {
  const guesses = ROUND3.map((step) => ceeGuess(step, "nijika", GUESSING_SETTINGS));
  const snapshot = ceeSnapshot({
    phase: "guessing",
    roundNumber: 3,
    syncRound: 1,
    settings: GUESSING_SETTINGS,
    players: seated(
      {
        [HOST.id]: { status: "playing", attempts: 2, marks: "❌💡" },
        [ME.id]: { status: "playing", attempts: 4, marks: "❌💡💡💡" },
        [PEACH.id]: { status: "playing", attempts: 3, marks: "❌❌💡" },
        [AZUMI.id]: { status: "playing", attempts: 1, marks: "⏱️", online: false },
        [KANADE.id]: { status: "surrendered", attempts: 2, marks: "❌❌🏳️" },
        [LONG.id]: { status: "playing" },
        [PASSERBY.id]: { status: "observing" },
      },
      { ready: true }
    ),
    chat: [
      ...joined(SEATED),
      chatLine(HOST, "这局开了标签全局 BP，别人先猜出的标签你们看不到", 30),
      chatLine(KANADE, "完全没头绪，我先放弃了", 110),
      chatLine(ME, "提示出来了，应该是个乐队角色", 196),
      chatLine(PEACH, `@${ME.name} 别剧透`, 202),
    ],
  });
  if (viewer === "spectator") {
    return {
      snapshot,
      privateState: ceePrivateState({
        playerId: PASSERBY.id,
        answer: CEE_CHARACTERS.nijika,
        guesses,
        imageHintLevel: 10,
      }),
    };
  }
  return {
    snapshot,
    privateState: ceePrivateState({
      canGuess: true,
      canSurrender: true,
      hints: NIJIKA_HINTS,
      imageHintAvailable: true,
      imageHintLevel: 6,
      deadlineAt: fromNow(42_000),
      guesses: guesses
        .filter((guess) => guess.playerId === ME.id)
        .map((guess) => hideDiscoveredTags(guess, ["乐队", "漫画改", "搞笑"])),
    }),
  };
}
/** 同步模式第 3 轮：本人已提交、桃子与 Kanade 尚未提交，本人等待其他玩家。 */
export function ceeSyncWaitingRoom(): CEERoomScenario {
  const settings = ceeSettings({ syncMode: true });
  const mine: CEEGuessStep[] = [
    { player: ME, character: "yui", at: 40, syncRound: 1 },
    { player: ME, character: "kikuri", at: 105, syncRound: 2 },
    { player: ME, character: "ryo", at: 170, syncRound: 3 },
  ];
  return {
    snapshot: ceeSnapshot({
      phase: "guessing",
      roundNumber: 3,
      syncRound: 3,
      settings,
      players: seated(
        {
          [HOST.id]: { attempts: 3, marks: "❌💡💡", syncCompleted: true },
          [ME.id]: { attempts: 3, marks: "❌💡💡", syncCompleted: true },
          [PEACH.id]: { attempts: 2, marks: "❌❌" },
          [AZUMI.id]: { attempts: 3, marks: "❌⏱️❌", syncCompleted: true },
          [KANADE.id]: { attempts: 2, marks: "❌💡" },
          [LONG.id]: { attempts: 3, marks: "❌❌❌", syncCompleted: true },
          [PASSERBY.id]: { status: "observing" },
        },
        { ready: true, status: "playing" }
      ),
      chat: [
        ...joined(SEATED),
        chatLine(PEACH, `@${ME.name} 等我一下，这轮还没想好`, 176),
        chatLine(HOST, "同步模式不着急，想好再交", 182),
      ],
    }),
    privateState: ceePrivateState({
      canSurrender: true,
      imageHintLevel: 7,
      guesses: mine.map((step) => ceeGuess(step, "nijika", settings)),
    }),
  };
}

/** 第 4 局由房主出题、桃子第二次猜中后结算；海豹猜中共同作品，出题人因题目过易扣分。 */
export function ceeSettledRoom(): CEERoomScenario {
  const round: CEEGuessStep[] = [
    { player: AZUMI, character: "gojo", at: 40 },
    { player: ME, character: "yui", at: 55 },
    { player: PEACH, character: "kikuri", at: 63 },
    { player: KANADE, character: "mio", at: 77 },
    { player: ME, character: "hitori", at: 92 },
    { player: PEACH, character: "nijika", at: 101 },
  ];
  const guesses = round.map((step) => ceeGuess(step, "nijika"));
  const scores = [
    scoreLine(ME, { score: 1, partial: 1, reason: "猜中共同作品" }),
    scoreLine(PEACH, { score: 4, base: 2, quickGuess: 2, reason: "猜中角色", rank: 1 }),
    scoreLine(AZUMI),
    scoreLine(KANADE),
    scoreLine(LONG),
    scoreLine(HOST, { score: -1, setter: -1, reason: "太简单了" }),
  ];
  return {
    snapshot: ceeSnapshot({
      phase: "settled",
      roundNumber: 4,
      syncRound: 1,
      setterPlayerId: HOST.id,
      roundSummary: ceeRoundSummary("nijika", scores, guesses),
      players: seated(
        {
          [HOST.id]: { status: "observing", score: 16 },
          [ME.id]: { attempts: 2, marks: "❌💡", score: 7 },
          [PEACH.id]: { status: "solved", attempts: 2, marks: "💡✔✌", score: 13 },
          [AZUMI.id]: { attempts: 1, marks: "❌", score: 3, ready: false },
          [KANADE.id]: { attempts: 1, marks: "❌", score: 2 },
          [LONG.id]: { score: 1 },
          [PASSERBY.id]: { status: "observing" },
        },
        { ready: true, status: "playing" }
      ),
      chat: [
        ...joined(SEATED),
        chatLine(PEACH, "两次就中了，这题有点简单", 108),
        chatLine(HOST, "下局换个冷门点的", 115),
      ],
    }),
    privateState: ceePrivateState({ playerId: HOST.id, answer: CEE_CHARACTERS.nijika, guesses }),
  };
}
/**
 * 原版房房主视角：上游连接中断，服务端不下发手动出题候选；Kanade 断线。
 * 原版房聊天只在增强版玩家之间互通，没有系统提示。
 */
export function ceeOriginalRoom(): CEERoomScenario {
  return {
    snapshot: ceeSnapshot({
      roomId: CEE_ORIGINAL_ROOM_ID,
      source: "original",
      name: "每日一猜",
      roundNumber: 2,
      upstreamConnected: false,
      players: [
        ceePlayer(HOST, { ready: true, score: 5 }),
        ceePlayer(KITAGAWA, { ready: true, score: 3 }),
        ceePlayer(PEACH, { score: 1 }),
        ceePlayer(KANADE, { online: false }),
      ],
      chat: [
        chatLine(KITAGAWA, "原版那边好像断了一下", 20),
        chatLine(HOST, "等它重连上再开下一局", 28),
      ],
    }),
    privateState: ceePrivateState({ playerId: HOST.id }),
  };
}

// ==================== 反作弊房 · 旁观批准 ====================

/** 大厅条目也覆盖一枚反作弊房：进房前就在卡片上标出「需客户端」。 */
export const CEE_LOBBY_ROOMS_WITH_ANTICHEAT: CEERoomSummary[] = [
  lobbyRoom("1357", "客户端专用房", "waiting", 3, { bakaAntiCheat: true }),
  ...CEE_LOBBY_ROOMS,
];

const spectateRequest = (member: Member): CEESpectateRequest => ({
  playerId: member.id,
  name: member.name,
  requestedAt: STORY_EPOCH + 60_000,
});

/** 反作弊房房主视角：路人甲已发起旁观请求、正待批准（`pendingSpectator`），房主就地同意或拒绝。 */
export function ceeAntiCheatHostRoom(): CEERoomScenario {
  const players = seated({ [PEACH.id]: { ready: false } }, { ready: true, score: 0 }).map(
    (player) =>
      player.id === PASSERBY.id ? { ...player, membership: "pendingSpectator" as const } : player
  );
  return {
    snapshot: ceeSnapshot({
      bakaAntiCheat: true,
      settings: ceeSettings({ bakaAntiCheat: true }),
      players,
      spectateRequests: [spectateRequest(PASSERBY)],
      chat: [...joined(SEATED), chatLine(PASSERBY, "我想旁观学习一下", 60)],
    }),
    privateState: ceePrivateState({ playerId: HOST.id }),
  };
}

/** 反作弊房请求者视角：本人已提交旁观、正在等房主批准，身份既非玩家也非旁观。 */
export function ceeAntiCheatPendingRoom(): CEERoomScenario {
  const players = seated({}, { ready: true }).map((player) =>
    player.id === PASSERBY.id ? { ...player, membership: "pendingSpectator" as const } : player
  );
  return {
    snapshot: ceeSnapshot({
      bakaAntiCheat: true,
      settings: ceeSettings({ bakaAntiCheat: true }),
      players,
      spectateRequests: [spectateRequest(PASSERBY)],
      chat: [...joined(SEATED)],
    }),
    privateState: ceePrivateState({
      playerId: PASSERBY.id,
      spectatePending: true,
      canGuess: false,
      canStart: false,
    }),
  };
}
