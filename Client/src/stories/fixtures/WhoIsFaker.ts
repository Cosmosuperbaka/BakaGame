import type {
  ChatMessage,
  DescriptionRecord,
  GamePhase,
  PlayerRole,
  PlayerSide,
  PrivateState,
  PublicPlayerView,
  RoomSnapshot,
  RoomSummary,
  RoundSummary,
  VoteRecord,
} from "@/types";
import { ABSTAIN_TARGET_ID, ROOM_ID_TEST_MODE } from "@/types";
import { buildDescriptionColumns, pendingColumn } from "@/lib/DescriptionColumns";
import { getSavedUsername, saveUsername } from "@/lib/Storage";
import type { PlayerListHistory } from "@/components/whoisfaker/layout/PlayerList";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { presetWhoIsFaker } from "@/stories/StorePresets";
import { STORY_EPOCH, STORY_PLAYERS, STORY_SPECTATORS } from "./Common";

// ==================== 谁是卧底故事的假数据 ====================
// 只供 Storybook 与截图使用。全部快照取自同一局的时间线，身份、词语、发言、投票与出局前后一致：
// 房间 1234「周五晚上的卧底局」第 3 轮，房主小布丁担任主持人；平民词「饺子」、卧底词「馄饨」、白板提示「一种面食」。
// 北川是白板，Kanade 是天使，桃子与柚子是卧底，其余为平民；路人甲旁观。
// 第 1 天石头出局，第 1 夜阿澄被刀；第 2 天补充发言后桃子与北川平票，PK 后桃子出局；
// 第 2 夜长名字玩家被刀；第 3 天柚子出局，卧底全灭，存活的白板北川进入终局猜词。

export const WIF_ROOM_ID = "1234";
export const WIF_ROOM_NAME = "周五晚上的卧底局";
export const WIF_ROOM_ROUTER = { route: `/whoisfaker/room/${WIF_ROOM_ID}`, path: "/whoisfaker/room/:roomId" };
export const WIF_TEST_ROUTER = { route: `/whoisfaker/room/${ROOM_ID_TEST_MODE}`, path: "/whoisfaker/room/:roomId" };

/** 与房间页游戏区一致的面板外壳；宽度取桌面三栏布局下游戏区的实际宽度。 */
export const WIF_STAGE_FRAME = "w-[36rem] overflow-hidden rounded-md border bg-panel p-6 md:p-8";
/** 与房间页左侧玩家栏一致的面板外壳；高度要容下九人等待列表之后的旁观分组与切换入口。 */
export const WIF_PLAYER_PANEL = "h-[44rem] w-[16rem] overflow-hidden rounded-md border bg-panel";
/** 展开发言历史时玩家栏会扩到游戏区，组件故事用同一宽度取景。 */
export const WIF_HISTORY_FRAME = "h-[36rem] w-[64rem] overflow-hidden rounded-md border bg-panel";

type Person = { id: string; name: string };

const [HOST, ME, PEACH, AZUMI, KANADE, KITA, LONG] = STORY_PLAYERS;
const [PASSERBY] = STORY_SPECTATORS;
// 白板与天使都要求至少 8 名可配置参与者，公共名单只有 7 人，这里补两位。
const YUZU: Person = { id: "player-8", name: "柚子" };
const STONE: Person = { id: "player-9", name: "石头" };

export const WIF_PEOPLE = {
  host: HOST, me: ME, peach: PEACH, azumi: AZUMI, kanade: KANADE, kita: KITA,
  long: LONG, yuzu: YUZU, stone: STONE, spectator: PASSERBY,
};

/** 本局参与者（不含主持人），顺序即入房顺序。 */
const PARTICIPANTS: Person[] = [ME, PEACH, AZUMI, KANADE, KITA, LONG, YUZU, STONE];

const ROLE_OF: Record<string, PlayerRole> = {
  [ME.id]: "civilian", [PEACH.id]: "undercover", [AZUMI.id]: "civilian", [KANADE.id]: "angel",
  [KITA.id]: "blank", [LONG.id]: "civilian", [YUZU.id]: "undercover", [STONE.id]: "civilian",
};
const SIDE_OF: Record<PlayerRole, PlayerSide> = { civilian: "good", angel: "good", undercover: "undercover", blank: "blank" };

export const WIF_WORDS = { civilianWord: "饺子", undercoverWord: "馄饨", blankHint: "一种面食" };
/** 服务端存储的词对按 localeCompare 排序。 */
const WORD_PAIR: [string, string] = ["饺子", "馄饨"];

/** 前两轮结束时的房间累计分。 */
const SCORE_BEFORE: Record<string, number> = {
  [HOST.id]: 2, [ME.id]: 3, [PEACH.id]: 4, [AZUMI.id]: 1, [KANADE.id]: 2,
  [KITA.id]: 1, [LONG.id]: 2, [YUZU.id]: 1, [STONE.id]: 0, [PASSERBY.id]: 0,
};

// ==================== 时间线 ====================

/** 第 3 轮的时间线节点，按发生顺序排列。 */
export const WIF_STAGES = [
  "waiting", "assigning", "words", "day1", "vote1", "night1", "day2", "sup2", "vote2",
  "tie2", "tieVote2", "night2", "day3", "vote3", "blankGuess", "blankReview", "over",
] as const;
export type WifStage = (typeof WIF_STAGES)[number];

const at = (stage: WifStage) => WIF_STAGES.indexOf(stage);
/** 每个节点在叙事时间轴上占 90 秒，聊天、发言与出局时间都据此排列。 */
const stageTime = (stage: WifStage, offsetSeconds: number) => STORY_EPOCH + (at(stage) * 90 + offsetSeconds) * 1000;

/** 出局发生在该节点结束时：之后的快照里该玩家已出局。 */
const ELIMINATED_AFTER: Record<string, WifStage> = {
  [STONE.id]: "vote1", [AZUMI.id]: "night1", [PEACH.id]: "tieVote2", [LONG.id]: "night2", [YUZU.id]: "vote3",
};
const isAlive = (playerId: string, stage: WifStage) => {
  const after = ELIMINATED_AFTER[playerId];
  return !after || at(stage) <= at(after);
};
// ==================== 发言 ====================

type SpeechStage = "day1" | "day2" | "sup2" | "tie2" | "day3";

/** 各发言子阶段的顺序与内容。顺序即服务端下发的 speechOrder。 */
const SPEECHES: Record<SpeechStage, { kind: DescriptionRecord["kind"]; cycle: number; index?: number; lines: [Person, string][] }> = {
  day1: {
    kind: "description", cycle: 1, lines: [
      [PEACH, "冬天吃很暖和"], [AZUMI, "要用面皮包起来"], [ME, "皮薄馅大最好吃"], [KANADE, "逢年过节常见"],
      [KITA, "和面粉有关"], [LONG, "蘸醋才香"], [YUZU, "一口一个"], [STONE, "北方人爱吃"],
    ],
  },
  day2: {
    kind: "description", cycle: 2, lines: [
      [KANADE, "面皮擀得很薄"], [PEACH, "可以煮在汤里"], [ME, "冬至必吃"], [LONG, "速冻的也不错"],
      [KITA, "用面做的"], [YUZU, "个头小小的"],
    ],
  },
  sup2: { kind: "supplement", cycle: 2, index: 1, lines: [[KITA, "可以当主食"], [YUZU, "我喜欢放紫菜虾皮"]] },
  tie2: { kind: "tieBreak", cycle: 2, index: 1, lines: [[PEACH, "馅料可荤可素"], [KITA, "吃起来很温暖"]] },
  day3: {
    kind: "description", cycle: 3, lines: [[YUZU, "外皮滑滑的"], [ME, "韭菜馅最好"], [KITA, "热乎乎的"], [KANADE, "和汤圆不一样"]],
  },
};

/** 各发言子阶段在故事中的默认进度：已提交的玩家。未列出的阶段视为全部提交。 */
const SUBMITTED_IN_PROGRESS: Partial<Record<SpeechStage, string[]>> = {
  day2: [KANADE.id, PEACH.id, LONG.id, YUZU.id],
  sup2: [KITA.id],
  tie2: [PEACH.id],
  day3: [YUZU.id, ME.id],
};

export const speechOrder = (stage: SpeechStage) => SPEECHES[stage].lines.map(([person]) => person.id);

function speechRecords(stage: SpeechStage, submitted?: string[]): DescriptionRecord[] {
  const { kind, cycle, index, lines } = SPEECHES[stage];
  // 服务端只公开「从第一位起连续已提交」的前缀：顺序没轮到的内容即使已提交也不下发。
  const visible: typeof lines = [];
  for (const line of lines) {
    if (submitted && !submitted.includes(line[0].id)) break;
    visible.push(line);
  }
  return visible.map(([person, text], order) => ({
    id: `desc-${stage}-${person.id}`, playerId: person.id, playerName: person.name, text, kind, cycle,
    ...(kind === "tieBreak" ? { tieBreakIndex: index } : kind === "supplement" ? { supplementIndex: index } : {}),
    order: order + 1, createdAt: stageTime(stage, 10 + order * 8),
  }));
}

const SPEECH_STAGES: SpeechStage[] = ["day1", "day2", "sup2", "tie2", "day3"];

/** 截至某个节点的公开发言：之前的子阶段全部公开，当前子阶段只公开连续前缀。 */
function publicDescriptions(stage: WifStage, submitted: Partial<Record<SpeechStage, string[]>> = SUBMITTED_IN_PROGRESS) {
  return SPEECH_STAGES.flatMap((speech) => {
    if (at(speech) > at(stage)) return [];
    return speechRecords(speech, speech === stage ? submitted[speech] : undefined);
  });
}

// ==================== 投票与夜间行动 ====================

const vote = (voter: Person, target: Person | "abstain"): VoteRecord =>
  ({ voterId: voter.id, targetId: target === "abstain" ? ABSTAIN_TARGET_ID : target.id });

/** 各轮完整票型。第 2 天 3:3 平票；PK 中柚子为避开队友选择弃票。 */
const VOTES = {
  vote1: [
    vote(ME, STONE), vote(PEACH, STONE), vote(AZUMI, YUZU), vote(KANADE, STONE),
    vote(KITA, YUZU), vote(LONG, KITA), vote(YUZU, STONE), vote(STONE, KITA),
  ],
  vote2: [vote(ME, PEACH), vote(PEACH, KITA), vote(KANADE, PEACH), vote(KITA, PEACH), vote(LONG, KITA), vote(YUZU, KITA)],
  tieVote2: [vote(ME, PEACH), vote(KANADE, PEACH), vote(LONG, PEACH), vote(YUZU, "abstain")],
  vote3: [vote(ME, YUZU), vote(KANADE, YUZU), vote(KITA, YUZU), vote(YUZU, KITA)],
} satisfies Record<string, VoteRecord[]>;

/** 夜间只有平民与卧底能行动；平民刀人会让自己出局，因此平民都选择不行动。 */
const NIGHT_ACTIONS = {
  night1: [
    { actorId: ME.id }, { actorId: PEACH.id, targetId: AZUMI.id }, { actorId: AZUMI.id },
    { actorId: LONG.id }, { actorId: YUZU.id, targetId: AZUMI.id },
  ],
  night2: [{ actorId: ME.id }, { actorId: LONG.id }, { actorId: YUZU.id, targetId: LONG.id }],
};

/** 进行中的默认进度：还没投票 / 行动的玩家。 */
const PENDING_ACTORS: Partial<Record<WifStage, string[]>> = {
  vote2: [ME.id, YUZU.id], tieVote2: [ME.id], vote3: [KITA.id, YUZU.id], night2: [ME.id],
};

function actionPreview(stage: WifStage) {
  const pending = new Set(PENDING_ACTORS[stage] ?? []);
  const votes = stage in VOTES ? VOTES[stage as keyof typeof VOTES] : [];
  const actions = stage in NIGHT_ACTIONS ? NIGHT_ACTIONS[stage as keyof typeof NIGHT_ACTIONS] : [];
  return {
    votes: votes.filter((item) => !pending.has(item.voterId)),
    nightActions: actions.filter((item) => !pending.has(item.actorId)),
  };
}

const VOTE_HISTORY = [
  { day: 1, votes: VOTES.vote1 }, { day: 2, votes: VOTES.vote2 },
  { day: 2, tieBreak: true, votes: VOTES.tieVote2 }, { day: 3, votes: VOTES.vote3 },
];
// ==================== 玩家名单 ====================

/** 房主标记与服务端一致按 hostPlayerId 推出：页面据此切换房主视图，玩家栏据此显示房主徽标。 */
export function wifPlayer(person: Person, overrides: Partial<PublicPlayerView> = {}): PublicPlayerView {
  return {
    id: person.id, name: person.name, score: SCORE_BEFORE[person.id] ?? 0, membership: "active", online: true,
    isReady: true, isBot: false, isHost: person.id === HOST.id, roundStatus: "waiting", ...overrides,
  };
}

const spectatorView = (overrides: Partial<PublicPlayerView> = {}) =>
  wifPlayer(PASSERBY, { membership: "spectator", roundStatus: "spectator", isReady: false, ...overrides });

/** 第 3 轮开始前：阿澄还没准备，Kanade 断线，路人甲在旁观。 */
export function waitingPlayers(overrides: Record<string, Partial<PublicPlayerView>> = {}): PublicPlayerView[] {
  const base: PublicPlayerView[] = [
    wifPlayer(HOST), ...PARTICIPANTS.map((person) => wifPlayer(person)), spectatorView(),
  ];
  const defaults: Record<string, Partial<PublicPlayerView>> = {
    [AZUMI.id]: { isReady: false }, [KANADE.id]: { online: false },
  };
  return base.map((player) => ({ ...player, ...defaults[player.id], ...overrides[player.id] }));
}

/** 人齐且全员准备。 */
export const readyPlayers = () => waitingPlayers({ [AZUMI.id]: { isReady: true }, [KANADE.id]: { online: true } });

/**
 * 局内名单：出题后参与者进入存活 / 出局；开启死亡揭露身份，出局者公开身份。
 * 终局时服务端已把本局得分加进累计分，`summary` 缺省取默认结算。
 */
export function roundPlayers(stage: WifStage, summary?: RoundSummary): PublicPlayerView[] {
  const assigned = at(stage) >= at("day1");
  const over = stage === "over";
  const awards = over ? (summary ?? wifRoundSummary()).awardedScores : [];
  const score = (person: Person) => (SCORE_BEFORE[person.id] ?? 0) + (awards.find((award) => award.playerId === person.id)?.delta ?? 0);
  const host = wifPlayer(HOST, { roundStatus: at(stage) >= at("words") ? "questioner" : "waiting" });
  const participants = PARTICIPANTS.map((person) => {
    if (!assigned) return wifPlayer(person);
    const alive = isAlive(person.id, stage);
    const after = ELIMINATED_AFTER[person.id];
    return wifPlayer(person, {
      roundStatus: alive ? "alive" : "dead",
      score: score(person),
      ...(!alive && after ? { eliminatedAt: stageTime(after, 80) } : {}),
      ...(!alive || over ? { revealedRole: ROLE_OF[person.id] } : {}),
    });
  });
  return [host, ...participants, spectatorView()];
}

// ==================== 私有视图 ====================

/** 观战视角：出题人与旁观者都能看到全部身份与当前投票 / 夜间行动。 */
function observerExtras(stage: WifStage): Partial<PrivateState> {
  if (at(stage) < at("day1")) return {};
  return {
    globalWords: WIF_WORDS,
    questionerView: PARTICIPANTS.map((person) => ({
      playerId: person.id, role: ROLE_OF[person.id], side: SIDE_OF[ROLE_OF[person.id]], alive: isAlive(person.id, stage),
    })),
    privilegedActionPreview: actionPreview(stage),
  };
}

/** 参与者本人拿到的身份与词语。 */
function roleExtras(person: Person, stage: WifStage): Partial<PrivateState> {
  if (at(stage) < at("day1")) return {};
  const role = ROLE_OF[person.id];
  const words = role === "civilian" ? { word: WIF_WORDS.civilianWord }
    : role === "undercover" ? { word: WIF_WORDS.undercoverWord }
      : role === "angel" ? { angelWordOptions: WORD_PAIR }
        : { blankHint: WIF_WORDS.blankHint };
  const guessUsed = role === "blank" && at(stage) >= at("blankGuess");
  return {
    role, side: SIDE_OF[role], ...words,
    canSubmitBlankGuess: role === "blank" && isAlive(person.id, stage) && !guessUsed && stage !== "over",
    blankGuessUsed: guessUsed,
  };
}

export type WifViewer = "host" | "me" | "spectator" | Person;

export function wifPrivate(viewer: WifViewer, stage: WifStage, overrides: Partial<PrivateState> = {}): PrivateState {
  const person = viewer === "host" ? HOST : viewer === "me" ? ME : viewer === "spectator" ? PASSERBY : viewer;
  const isQuestioner = person.id === HOST.id && at(stage) >= at("words");
  const observer = isQuestioner || person.id === PASSERBY.id;
  return {
    playerId: person.id, sessionToken: `story-session-${person.id}`, isQuestioner,
    canSubmitBlankGuess: false, blankGuessUsed: false, nightActionSubmitted: false,
    ...(observer ? observerExtras(stage) : person.id === HOST.id ? {} : roleExtras(person, stage)),
    ...overrides,
  };
}
// ==================== 聊天 ====================

/**
 * 一段谁是卧底房的聊天：系统提示、@提及、阶段提示与长文本换行。
 * 聊天按节点截断——第 2 天的快照不能出现「第 3 天开始」，否则与顶栏的对局进度自相矛盾。
 */
export function wifChat(stage: WifStage = "over"): ChatMessage[] {
  const say = (person: Person, text: string, offsetSeconds: number) =>
    ({ id: `wif-chat-${person.id}-${offsetSeconds}`, playerId: person.id, playerName: person.name, text, createdAt: STORY_EPOCH + offsetSeconds * 1000, system: false });
  const note = (text: string, offsetSeconds: number) =>
    ({ id: `wif-chat-sys-${offsetSeconds}`, playerId: "", playerName: "", text, createdAt: STORY_EPOCH + offsetSeconds * 1000, system: true });
  const lines: ChatMessage[] = [
    note(`${HOST.name} 创建了房间`, 0),
    note(`${ME.name} 加入了房间`, 6),
    say(HOST, "八个人正好，卧底两个、天使一个、白板一个", 14),
    say(PEACH, `@${ME.name} 描述别太直白，上一局就是被你一句话点破的`, 26),
    say(ME, "这局我收敛一点，只说做法不说名字", 33),
    say(AZUMI, "我先说个宽泛的，大家从第二个人开始应该就能收窄了，别一上来就咬死同一个方向，不然卧底顺着我们的说法描述反而更安全", 48),
    say(KANADE, "石头怎么一直不说话", 62),
    say(LONG, "他在打字，打了一半又删了", 70),
    note("第 1 天开始", at("day1") * 90),
    note("第 2 天开始", at("day2") * 90),
    say(YUZU, "昨天的票型有点怪，石头那八票里有几票是跟风投的", at("day2") * 90 + 12),
    note("第 3 天开始", at("day3") * 90),
    say(KITA, "我现在只想听大家怎么说", at("day3") * 90 + 9),
  ];
  // 每个节点在时间轴上占 90 秒，聊天只保留该节点结束前发出的内容。
  const endsAt = stageTime(stage, 90);
  return lines.filter((line) => line.createdAt < endsAt);
}

// ==================== 房间快照 ====================

const PHASE_OF: Record<WifStage, GamePhase> = {
  waiting: "waiting", assigning: "assigningQuestioner", words: "wordSubmission",
  day1: "description", vote1: "voting", night1: "night",
  day2: "description", sup2: "description", vote2: "voting",
  tie2: "tieBreak", tieVote2: "tieBreak", night2: "night",
  day3: "description", vote3: "voting",
  blankGuess: "blankGuess", blankReview: "blankGuess", over: "gameOver",
};

const DAY_OF: Record<WifStage, number> = {
  waiting: 0, assigning: 0, words: 0,
  day1: 1, vote1: 1, night1: 1,
  day2: 2, sup2: 2, vote2: 2, tie2: 2, tieVote2: 2, night2: 2,
  day3: 3, vote3: 3, blankGuess: 3, blankReview: 3, over: 3,
};

/** 节点 → 当前的发言子阶段；非发言阶段为空。 */
const SPEECH_OF: Partial<Record<WifStage, SpeechStage>> = {
  day1: "day1", day2: "day2", sup2: "sup2", tie2: "tie2", day3: "day3",
};

const SPEECH_MODE_OF: Partial<Record<SpeechStage, NonNullable<RoomSnapshot["status"]["speechMode"]>>> = {
  sup2: "supplement", tie2: "tieBreak",
};

/** 第 2 天平票 PK 的两位候选。 */
const TIE_CANDIDATES = [PEACH, KITA];

/** 白板在终局的两次猜测：第一次未通过，等待主持人裁定。 */
const BLANK_GUESS_WORDS: [string, string] = ["饺子", "汤圆"];

function stageStatus(
  stage: WifStage,
  submitted: Partial<Record<SpeechStage, string[]>>,
): RoomSnapshot["status"] {
  const phase = PHASE_OF[stage];
  const status: RoomSnapshot["status"] = {
    phase, started: at(stage) >= at("assigning"), day: DAY_OF[stage],
    ...(at(stage) >= at("assigning") ? { roundId: "wif-round-3" } : {}),
    ...(at(stage) >= at("words") ? { questionerPlayerId: HOST.id } : {}),
  };
  const speech = SPEECH_OF[stage];
  if (speech) {
    const order = speechOrder(speech);
    status.speechMode = SPEECH_MODE_OF[speech] ?? "normal";
    status.speechOrder = order;
    status.submittedSpeechPlayerIds = submitted[speech] ?? order;
    if (speech === "sup2") {
      status.supplementIndex = SPEECHES.sup2.index;
      status.speechResumePhase = "description";
      status.pendingSupplementPlayerIds =
        order.filter((playerId) => !(submitted.sup2 ?? []).includes(playerId));
    }
    if (speech === "tie2") {
      status.tieBreakIndex = SPEECHES.tie2.index;
      status.tieBreakStage = "description";
      status.tieBreakCandidateIds = TIE_CANDIDATES.map((person) => person.id);
    }
    if (SPEECH_MODE_OF[speech] === undefined) status.descriptionOrder = order;
  }
  if (stage === "tieVote2") {
    status.tieBreakStage = "vote";
    status.tieBreakIndex = SPEECHES.tie2.index;
    status.tieBreakCandidateIds = TIE_CANDIDATES.map((person) => person.id);
  }
  if (stage === "blankGuess" || stage === "blankReview") {
    status.blankGuessPlayerId = KITA.id;
    status.blankGuessReason = "finale";
  }
  if (stage === "blankReview") {
    status.blankGuessDraft = BLANK_GUESS_WORDS;
    status.blankGuessPendingReview = true;
  }
  if (stage === "waiting") {
    // 阿澄掉线未处理：等待阶段没有这个字段，掉线只在局内由出题人裁定。
    status.started = false;
  }
  return status;
}
// ==================== 结算 ====================

/**
 * 与服务端 `finishRound` 同口径的本局得分：只有获胜阵营记分（白板胜 +2，好人或卧底胜 +1），中止的局不记分；
 * 主持人没有身份，不在其中。
 */
function awardsFor(winner: RoundSummary["winner"]): RoundSummary["awardedScores"] {
  if (winner === "aborted") return [];
  return PARTICIPANTS.filter((person) => SIDE_OF[ROLE_OF[person.id]] === winner)
    .map((person) => ({ playerId: person.id, delta: winner === "blank" ? 2 : 1 }));
}

/** 第 3 轮结算：卧底全灭、白板存活并进入猜词，因此由白板拿下这一局。得分按最终的 `winner` 推出，覆写胜方即换一套得分。 */
export function wifRoundSummary(overrides: Partial<RoundSummary> = {}): RoundSummary {
  const winner = overrides.winner ?? "blank";
  return {
    winner,
    reason: "卧底全部出局，白板存活并猜中词语",
    awardedScores: awardsFor(winner),
    // 主持人只出题，服务端只给参与者分配身份。
    revealedRoles: PARTICIPANTS.map((person) => ({ playerId: person.id, role: ROLE_OF[person.id] })),
    descriptions: publicDescriptions("day3"),
    blankGuesses: [{
      playerId: KITA.id, guessedWords: BLANK_GUESS_WORDS, success: true, reason: "finale",
      approvedByQuestioner: true, createdAt: stageTime("blankReview", 20),
    }],
    words: { pair: WORD_PAIR, ...WIF_WORDS },
    voteHistory: VOTE_HISTORY,
    ...overrides,
  };
}

/** 卧底阵营胜利的结算：用于终局的不同结局。 */
export const undercoverWinnerSummary = () => wifRoundSummary({
  winner: "undercover",
  reason: "存活卧底人数与好人持平",
  blankGuesses: [],
});

/** 好人阵营胜利的结算：白板未猜中，平民留下最后一人。 */
export const goodWinnerSummary = () => wifRoundSummary({
  winner: "good",
  reason: "卧底与白板全部出局",
  blankGuesses: [{
    playerId: KITA.id, guessedWords: ["面团", "汤圆"] as [string, string], success: false, reason: "finale",
    createdAt: stageTime("blankReview", 20),
  }],
});

export {
  VOTE_HISTORY,
};
// ==================== 各节点快照 ====================

type SnapshotPatch = Partial<RoomSnapshot>;

/** 与服务端默认设置一致：8 人局，两个卧底，带天使与白板，出局公开身份。 */
export function wifSettings(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  const base: RoomSnapshot = {
    roomId: WIF_ROOM_ID, name: WIF_ROOM_NAME, visibility: "public", allowSpectators: true,
    hasPassword: false, hostPlayerId: HOST.id, testMode: false,
    roleLimits: { maxUndercoverCount: 3, canEnableAngel: true, canEnableBlank: true },
    settings: { roleConfig: { undercoverCount: 2, hasAngel: true, hasBlank: true }, revealRoleOnDeath: true },
    status: stageStatus("waiting", {}),
    players: waitingPlayers(), descriptions: [], chat: wifChat("waiting"),
  };
  const snapshot = { ...base, ...overrides };
  return { ...snapshot, players: snapshot.players.map((player) => ({ ...player, isHost: player.id === snapshot.hostPlayerId })) };
}

/** 按节点产出整局快照。玩家名单、发言、聊天与结算都取自同一条时间线。 */
export function wifSnapshot(stage: WifStage, overrides: SnapshotPatch = {}): RoomSnapshot {
  // 结算表与玩家栏的累计分取自同一份结算：覆写胜方时两处一起换。
  const summary = stage === "over" ? (overrides.summary ?? wifRoundSummary()) : undefined;
  const players = at(stage) >= at("assigning") ? roundPlayers(stage, summary) : waitingPlayers();
  return wifSettings({
    status: stageStatus(stage, SUBMITTED_IN_PROGRESS),
    players,
    descriptions: publicDescriptions(stage),
    chat: wifChat(stage),
    ...(summary ? { summary } : {}),
    ...overrides,
  });
}

/** 房间页直接落在已入房状态：路由房间号、Store 房间号与快照房间号三者一致即不会发起入房请求。 */
export function presetWifRoom(snapshot: RoomSnapshot, privateState: PrivateState) {
  presetWhoIsFaker({
    connected: true, roomId: snapshot.roomId, sessionToken: privateState.sessionToken, snapshot, privateState,
  });
}

type WifStore = typeof useWhoIsFakerStore extends { getState: () => infer T } ? T : never;
type WifStoreActions = Pick<WifStore, "sendCommand" | "joinRoom" | "createRoom" | "reconnectRoom">;

/** 替换 Store 上的网络动作；预览层在下一个故事前会整体重置 Store，替换不会外溢。 */
export function stubWifActions(actions: Partial<WifStoreActions>) {
  useWhoIsFakerStore.setState(actions);
}

/** 按命令类型应答的 `sendCommand` 替身。 */
export function stubWifCommand(handler: (type: string, payload?: Record<string, unknown>) => Promise<unknown>) {
  stubWifActions({ sendCommand: handler as unknown as WifStore["sendCommand"] });
}
// ==================== 大厅 ====================

function lobbyRoom(roomId: string, name: string, overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    roomId, name, visibility: "public", allowSpectators: true, hasPassword: false,
    playerCount: 2, spectatorCount: 0, onlineCount: 2, phase: "waiting", testMode: false, ...overrides,
  };
}

/** 覆盖等待中 / 游戏中 / 私密带密码 / 禁观战 / 超长房间名与测试房。 */
export const WIF_LOBBY_ROOMS: RoomSummary[] = [
  lobbyRoom(WIF_ROOM_ID, WIF_ROOM_NAME, { playerCount: 8, spectatorCount: 1, onlineCount: 9 }),
  lobbyRoom("2718", "第一局先熟悉规则", { phase: "description", playerCount: 7, spectatorCount: 2, onlineCount: 9 }),
  lobbyRoom("3141", "深夜卧底局", { visibility: "private", hasPassword: true, playerCount: 6, spectatorCount: 0, onlineCount: 6 }),
  lobbyRoom("5920", "只带熟人，谢绝观战", { allowSpectators: false, phase: "voting", playerCount: 5, spectatorCount: 0, onlineCount: 5 }),
  lobbyRoom("8086", "名称很长的房间用于检查截断：周末晚上八点准时开始谁先出局谁请喝奶茶", {
    phase: "gameOver", playerCount: 12, spectatorCount: 10, onlineCount: 22,
  }),
  lobbyRoom(ROOM_ID_TEST_MODE, "测试房间", { testMode: true, playerCount: 1, spectatorCount: 0, onlineCount: 1 }),
];

/** 预置本机用户名；返回的清理函数恢复原值。 */
export function seedWifUsername(name: string) {
  const previous = getSavedUsername();
  saveUsername(name);
  return () => saveUsername(previous);
}

// ==================== 发言历史列 ====================

/**
 * 玩家栏展开发言历史时的列模型，与房间页 `useMemo` 里的算法一致：
 * 按“正常轮次 → 平票 PK → 补充发言”展开列，进行中的那一列补上待提交格子。
 */
export function wifHistory(stage: WifStage): PlayerListHistory {
  const status = stageStatus(stage, SUBMITTED_IN_PROGRESS);
  const descriptions = publicDescriptions(stage);
  const { columns, byPlayer, playerOrder } = buildDescriptionColumns(descriptions, status);
  const players = roundPlayers(stage);
  const present = new Set(players.map((player) => player.id));
  const departed = new Map<string, PublicPlayerView>();
  for (const record of descriptions) {
    if (present.has(record.playerId) || departed.has(record.playerId)) continue;
    departed.set(record.playerId, wifPlayer({ id: record.playerId, name: record.playerName }, { online: false }));
  }
  return {
    columns, byPlayer, playerOrder, departedPlayers: [...departed.values()],
    submittedColumnKey: pendingColumn(status)?.key,
    submittedPlayerIds: new Set(status.submittedSpeechPlayerIds ?? []),
  };
}

/** 组件故事里 `isPending` 的默认值：没有进行中的命令。 */
export const noPending: (type: string) => boolean = () => false;

/** 永不结算的请求，用于固定“提交中”这类进行态。 */
export const pending = <T,>() => new Promise<T>(() => {});
