// ==================== CCB（二刺猿笑传之猜猜呗 · 增强版）契约 ====================
// 只依赖 Model.ts / Protocol.ts，严禁 import 另两个游戏的契约。
//
// 分工：本文件定义**房间生命周期 / 大厅 / 玩家视图 / 传输消息**；
// 反馈判定与计分的具体语义由 `domain/CCBRules.ts` 承载（P1 落地，需对着原版
// `anime-character-guessr/client/src/utils/bangumi.js` 的 `generateFeedback` 逐字段复刻，
// 并用 `CCBFilter/data/data.json` 对拍）。因此这里只保留承载它们的**容器字段**，
// 不预先编码标记/等级的取值语义——写错的契约比没有契约更糟。
//
// 分阶段落点：本文件是**目标形态**，不代表当前已挂载。各字段的落点阶段在注释中标注。

import type { ChatMessage, PlayerMembership, RoomVisibility } from "./Model";
import type { ClientEnvelope } from "./Protocol";

/**
 * 房间/对局阶段。
 *
 * 原版没有显式 phase，靠 `currentGame` / `waitingForAnswer` / `answerSetterId` 组合推导；
 * 本实现按本项目规范收敛成显式枚举与迁移表（见 `Agents/CCB.md`）。
 */
export const CCB_PHASES = ["waiting", "answering", "guessing", "settled"] as const;
export type CCBPhase = (typeof CCB_PHASES)[number];

/**
 * 对局模式。
 * - `normal`：先猜对者结束本局，其余玩家继续到次数耗尽。
 * - `sync`：全员完成本轮才推进轮次，胜者等本轮结束后统一结算。
 * - `bloodbath`：淘汰制，按名次给分（`max(1, 参战人数 − 已胜人数)`），直至全员结束。
 */
export const CCB_GAME_MODES = ["normal", "sync", "bloodbath"] as const;
export type CCBGameMode = (typeof CCB_GAME_MODES)[number];

/** 角色性别口径：非男非女一律 `?`（与构建期归一化、原版反馈判定同一口径）。 */
export type CCBGender = "male" | "female" | "?";

/** 作品类型（Bangumi `subject.type`）：1 书籍 / 2 动画 / 4 游戏 / 6 三次元。 */
export const CCB_SUBJECT_TYPES = [1, 2, 4, 6] as const;
export type CCBSubjectType = (typeof CCB_SUBJECT_TYPES)[number];

/**
 * 大类选项：原版把「大类」与普通 meta 标签**混在同一个 `metaTags: string[]` 里**，
 * 并用 `metaTags[0]`（primary）决定作品类型 —— 这条规则被 `getRandomCharacter` 与
 * `getCharacterAppearances` 共用，所以必须原样保留「有序数组 + 首元素为准」的形态。
 * 本表是允许出现在数组里的大类字面量；其余元素一律视为 meta 标签过滤项。
 */
export const CCB_CATEGORY_META_TAGS = ["动画", "游戏", "Galgame", "书籍", "三次元", "全部"] as const;
export type CCBCategoryMetaTag = (typeof CCB_CATEGORY_META_TAGS)[number];

/**
 * 大类 → 作品类型。`Galgame` 与 `游戏` 都是 4，区别只在 meta 标签过滤：
 * 原版 `primaryTag === 'Galgame'` 时把 meta 过滤项**替换**成 `['Galgame']`。
 */
export const CCB_CATEGORY_TYPES: Record<CCBCategoryMetaTag, number[]> = {
  动画: [2],
  游戏: [4],
  Galgame: [4],
  书籍: [1],
  三次元: [6],
  全部: [1, 2, 4, 6],
};

/** 单条自定义短消息长度上限（玩家点自己名字编辑）。 */
export const CCB_PLAYER_MESSAGE_LIMIT = 32;

/** 角色搜索结果：字段全部来自本地只读数据集，图片由回填缓存补充。 */
export interface CCBCharacterSearchResult {
  id: number;
  /** 原名（多为日文）。 */
  name: string;
  /** 简体中文名；本地缺失时回落到 `name`。 */
  nameCn: string;
  gender: CCBGender;
  /** 热度＝`collects + comments`。 */
  popularity: number;
  imageUrl?: string;
}

/** 角色标签（来自 `character_tags` 表的上游 `id_tags` 快照）。 */
export interface CCBCharacterTags {
  id: number;
  tags: string[];
}

/**
 * 对局设置。字段口径逐条对齐原版 `gameSettings`（见 `Agents/CCB.md §6.6` 对照表）：
 * 只有 `mode` 是把原版的 `syncMode` / `nonstopMode` 两个布尔收敛成枚举，其余保持同名同义。
 */
export interface CCBGameSettings {
  mode: CCBGameMode;
  /**
   * 大类 + meta 标签过滤项，**有序**：`[0]` 为 primary，决定取哪些作品类型（`CCB_CATEGORY_TYPES`）。
   * 非大类的元素作为 meta 标签过滤项传给作品检索。
   */
  metaTags: string[];
  /** 起始年份（含）。 */
  startYear?: number;
  /** 结束年份（含）。原版会与当前年份取 min。 */
  endYear?: number;
  /** 每年取热度前 N 部作品；原版另与 1000 取 min。0 表示不限。 */
  topNSubjects: number;
  /** 按年份均分抽样（原版 `useSubjectPerYear`）。关闭时在整段年份区间内一起排序。 */
  useSubjectPerYear: boolean;
  /** 从作品中取前 N 个主角/配角作为候选题面角色（原版 `characterNum`）。 */
  characterNum: number;
  /** 只从「主角」里出题（原版 `mainCharacterOnly`）。 */
  mainCharacterOnly: boolean;
  /** 每位玩家的猜测次数上限（原版 `maxAttempts`，默认 10）。 */
  maxAttempts: number;
  /** 单局时限（毫秒）；`<= 0` 表示不限时，否则下限 10 秒（原版 `timeLimit` 以秒计）。 */
  timeLimitMs: number;
  /** 文本提示阈值（剩余次数），从左到右从大到小；空数组＝关闭（原版 `useHints`）。 */
  useHints: number[];
  /** 图片提示阈值（剩余次数），模糊半径＝剩余次数；`0`＝关闭（原版 `useImageHint`）。 */
  useImageHint: number;
  /** 共同标签模式：标签池改由作品 `rawTags` 驱动（原版 `commonTags`）。 */
  commonTags: boolean;
  /** `metaTags` / 共同标签模式下展示的作品标签数（原版 `subjectTagNum`，默认 3）。 */
  subjectTagNum: number;
  /** 展示的角色标签数（原版 `characterTagNum`）。 */
  characterTagNum: number;
  /** 标签全局 BP：被他人揭示过的共享标签对自己显示为 `???`。 */
  tagBan: boolean;
  /** 角色全局 BP：同一角色不可被重复猜（原版对「自己猜过的」放行）。 */
  globalPick: boolean;
  /** 允许「先搜作品、再从作品里挑角色」的搜索模式（原版 `subjectSearch`，纯前端行为）。 */
  subjectSearch: boolean;
}

/** 原版 `createBasePreset()` 的默认年份窗口是 `[当前年 − 10, 当前年]`。 */
const DEFAULT_YEAR = new Date().getFullYear();

/**
 * 默认设置，逐字段对齐原版 `client/src/data/presets.js` 的 `createBasePreset()`。
 *
 * ⚠️ 三处容易照「直觉」写错的地方：
 * ① `metaTags` 默认是**三个空串**（不是 `["动画"]`）—— 空串被过滤掉即「不加 meta 过滤」，
 *    而 primary 为空走默认分支得到 `type = [2]`，所以默认就是「全部动画」。
 *    写成 `["动画"]` 会把题库收窄到 meta_tags 含「动画」的那 1428 部（实测）。
 * ② `commonTags` 默认是 **`true`**（共同标签模式），不是 `false`。
 * ③ `timeLimitMs` 默认 **0（不限时）** —— 原版 `timeLimit` 在基础预设里根本没有，
 *    含义就是「留空即关闭」。
 */
export const DEFAULT_CCB_SETTINGS: CCBGameSettings = {
  mode: "normal",
  metaTags: ["", "", ""],
  startYear: DEFAULT_YEAR - 10,
  endYear: DEFAULT_YEAR,
  topNSubjects: 50,
  useSubjectPerYear: false,
  characterNum: 6,
  mainCharacterOnly: true,
  maxAttempts: 10,
  timeLimitMs: 0,
  useHints: [],
  useImageHint: 0,
  commonTags: true,
  subjectTagNum: 3,
  characterTagNum: 4,
  tagBan: false,
  globalPick: false,
  subjectSearch: true,
};

/**
 * 玩家公共视图。
 *
 * `marks` 是原版「标记串」的直译：尝试类标记与结束类标记按发生顺序拼接。
 * 各字符的确切语义由 `CCBRules.ts` 定义（P1），这里只保证它是一个可展示的字符串。
 */
export interface CCBPlayerView {
  id: string;
  name: string;
  score: number;
  membership: PlayerMembership;
  online: boolean;
  isReady: boolean;
  isBot: boolean;
  /** 由 `hostPlayerId` 派生，不是独立状态。 */
  isHost: boolean;
  /** 自定义短消息（玩家点自己名字编辑）。 */
  message: string;
  /** 本局标记串。 */
  marks: string;
  /** 本局已用猜测次数。 */
  guessCount: number;
  /** 本局是否已完成（同步模式与血战模式据此推进）。 */
  finished: boolean;
  /** 队伍：`null`＝无队伍，`'0'`＝观战，`'1'..'8'`＝队伍号（P3 启用）。 */
  team: string | null;
}

export interface CCBRoomSummary {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  playerCount: number;
  spectatorCount: number;
  onlineCount: number;
  phase: CCBPhase;
}

/** 答案卡在 `settled` 之外只对出题人与观战者可见；增强版一律由服务端权威出题。落点 P1。 */
export interface CCBAnswerView {
  id: number;
  name: string;
  nameCn: string;
  imageUrl?: string;
  /** 是否允许非出题人查看（对局结束后公开）。 */
  revealed: boolean;
}

/** 第一级采样得到的作品（出题数据源与房间记录共用）。 */
export interface CCBSubjectPick {
  id: number;
  name: string;
  nameCn: string;
}

export interface CCBRoomSnapshot {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  allowSpectators: boolean;
  hasPassword: boolean;
  hostPlayerId: string;
  testMode: boolean;
  settings: CCBGameSettings;
  phase: CCBPhase;
  /** 本局序号（从 1 开始，跨局累计）。 */
  roundNumber: number;
  /** 出题人：服务端出题的房间里指向被指定的房主；手动出题模式下是被指定的玩家。落点 P1/P3。 */
  answerSetterPlayerId?: string;
  /** 本局截止时间；未限时则为空。落点 P1。 */
  guessDeadlineAt?: number;
  players: CCBPlayerView[];
  chat: ChatMessage[];
  /** 仅在对局结束（`settled`）或允许观战时下发。落点 P1。 */
  answer?: CCBAnswerView;
  /** 被全局 BP 屏蔽的标签（`tagBan` 生效时会以 `???` 展示）。落点 P2。 */
  bannedTags?: string[];
  /** 同步模式的本轮进度；非同步模式不下发。落点 P2。 */
  syncProgress?: CCBSyncProgress;
  /** 血战模式按猜对顺序累积的胜者；非血战模式不下发。落点 P2。 */
  nonstopWinnerIds?: string[];
}

/**
 * 同步模式的本轮进度（原版 `currentGame.syncRound` + `syncPlayersCompleted`）。
 *
 * 同步模式把「同一答案下每人的一次猜测」当作一轮：本轮全员完成才推进轮次，
 * 出现胜者后也要等本轮结束才结算。
 */
export interface CCBSyncProgress {
  /** 当前轮次，从 1 开始，每局重置。 */
  round: number;
  /** 本轮已完成的玩家 id（猜过、超时或投降都算完成）。 */
  completedPlayerIds: string[];
}

export interface CCBPrivateState {
  playerId: string;
  sessionToken: string;
  /**
   * 出题人可设答案（手动出题模式）。
   *
   * 仅当 `phase === "answering"` 且自己就是被房主指定的出题人时为 `true`。
   */
  canSetAnswer: boolean;
  /** 当前是否可提交猜测。落点 P1。 */
  canGuess: boolean;
  canSurrender: boolean;
  canStartRound: boolean;
  /** 剩余猜测次数。 */
  remainingGuesses: number;
  /** 只有自己可见的猜测记录（含逐字段反馈）。落点 P1。 */
  ownGuesses: CCBGuessRecord[];
  /**
   * 本条**已该显示**的文本提示，按 `useHints` 的阈值逐条解锁。
   *
   * 判定式照原版客户端：`剩余次数 <= useHints[i]` 时显示第 i 条。
   * 提示文本由手动出题的出题人提供（`ccb.game.setAnswer.hints`）—— 服务端抽题没有出处，
   * 所以那种局面下恒为空数组。
   */
  hints: CCBRevealedHint[];
  /**
   * 观战增强视图：全部玩家的猜测明细（**只给旁观者与出题人**下发）。
   *
   * 猜测记录含答案相关线索，所以默认只给自己（`ownGuesses`）；观战者不参与竞猜，
   * 给他们看全场，「观战」才真的有内容可看。总条数有上限，见服务端归一化。
   */
  spectatedGuesses?: CCBSpectatedGuesses[];
  /**
   * 同步模式：本轮是否已完成。
   *
   * 与 `canGuess` 是一对：同步模式每人每轮只能猜一次，猜完（或超时）后
   * 必须等本轮其他人完成、轮次推进后才能再猜。非同步模式恒为 `false`。
   */
  syncCompleted: boolean;
  /**
   * 手动出题：出题人在本局进行中看到的答案卡。
   *
   * 答案不进 `snapshot`（那里只在对局结束后公开），因为同一个快照要广播给全房；
   * 出题人自己选的答案走私有状态下发，刷新页面也不会丢。
   */
  setterAnswer?: CCBAnswerView;
}

/** 一条已解锁的文本提示（见 `CCBPrivateState.hints`）。 */
export interface CCBRevealedHint {
  /** 1 起的序号，对应设置里第几条阈值。 */
  index: number;
  text: string;
}

/** 观战视图里某位玩家的猜测明细（见 `CCBPrivateState.spectatedGuesses`）。 */
export interface CCBSpectatedGuesses {
  playerId: string;
  playerName: string;
  marks: string;
  finished: boolean;
  guesses: CCBGuessRecord[];
}

/** 比较类反馈。`=` 相等 / `+`·`++` 偏高 / `-`·`--` 偏低 / `?` 不可比。 */
export type CCBCompareFeedback = "=" | "+" | "++" | "-" | "--" | "?";
export interface CCBScalarFeedback {
  /** `?` 表示该侧不可比（原版用 `-1` 哨兵）。 */
  guess: number | "?";
  feedback: CCBCompareFeedback;
}

export interface CCBSharedAppearancesFeedback {
  /** 按**作品名**求交集得到的第一个共同作品。 */
  first: string;
  /** 按 **subject id** 求交集得到的第一个共同作品原名。 */
  firstOriginal: string;
  /** 同上，中文名。 */
  firstCn: string;
  /** 共同作品数：优先取 id 交集的大小，为空时回落到名字交集的大小。 */
  count: number;
}

/**
 * 一次猜测的逐字段反馈。8 个字段与原版 `generateFeedback` 一一对应。
 *
 * 放在共享契约里（而不是 `domain/CCBRules.ts`）是因为**客户端要渲染它**：
 * 高亮色与 ↑↓ 箭头都依赖这些取值，前端必须拿到同一份类型。
 * 判定逻辑仍在 `CCBRules.generateCCBFeedback`，这里只有形状。
 */
export interface CCBFeedback {
  gender: { guess: CCBGender; feedback: "yes" | "no" };
  popularity: CCBScalarFeedback;
  /** 最高分（`highestRating`），**不是**平均分。 */
  rating: CCBScalarFeedback;
  shared_appearances: CCBSharedAppearancesFeedback;
  appearancesCount: CCBScalarFeedback;
  metaTags: { guess: string[]; shared: string[] };
  latestAppearance: CCBScalarFeedback;
  earliestAppearance: CCBScalarFeedback;
}

/** 本局结束方式，由标记串推断（`🏆` > `💀` > `🏳️`）。 */
export type CCBEndResult = "teamwin" | "lose" | "surrender" | "";

/**
 * 一次猜测的记录。
 *
 * `feedback` 的结构由 `shared/CCB.ts` 定义、取值由 `domain/CCBRules.ts` 计算，
 * 两侧共用同一份契约 —— 客户端不再需要自己复刻判定逻辑。
 */
export interface CCBGuessRecord {
  characterId: number;
  characterName: string;
  characterNameCn: string;
  imageUrl?: string;
  submittedAt: number;
  correct: boolean;
  feedback: CCBFeedback;
}

// ==================== 服务端内部记录（跨层传递，故与另两个游戏一致放在 shared） ====================

export interface CCBPlayerRecord {
  id: string;
  name: string;
  sessionToken: string;
  membership: PlayerMembership;
  online: boolean;
  isReady: boolean;
  isBot: boolean;
  score: number;
  /** 自定义短消息（玩家点自己名字编辑）。 */
  message: string;
  /** 本局标记串（由 `CCBRules` 拼接与去重）。 */
  marks: string;
  /** 本局已用猜测次数。 */
  guessCount: number;
  /** 本局是否已完成（同步模式与血战模式据此推进）。 */
  finished: boolean;
  /** 队伍：`null`＝无队伍，`'0'`＝观战，`'1'..'8'`＝队伍号（P3 启用）。 */
  team: string | null;
  /** 同步模式下已完成到第几轮（P2）。 */
  syncCompletedRound?: number;
  joinedAt: number;
  lastSeenAt: number;
  connectionId?: string;
}

/** 落点 P1。 */
export interface CCBRoundRecord {
  roundNumber: number;
  answerCharacterId: number;
  answerSetterPlayerId: string;
  /**
   * 答案是否由**真人**指定（手动出题模式）。
   *
   * ⚠️ 这是决定「要不要结算出题人分」的唯一依据：服务端出题的房间里
   * `answerSetterPlayerId` 只是记成房主（原版那套出题人奖惩没有对象），
   * 照原版把分记到房主头上属于凭空加减分。
   */
  answerIsManual: boolean;
  startedAt: number;
  deadlineAt?: number;
  /** 已提交的猜测，按玩家分组。 */
  guesses: Record<string, CCBGuessRecord[]>;
  /** 已猜对的玩家。 */
  solvedPlayerIds: string[];
  /** 被全局 BP 屏蔽的标签（`tagBan` 生效时才会非空）。 */
  bannedTags: string[];
  /** 每个被屏蔽标签的**有权查看者**：不在名单里的玩家会看到 `???`。 */
  bannedTagRevealers: Record<string, string[]>;
  /** 本局累积但**尚未生效**的屏蔽标签（原版 `tagBanStatePending`：结算时才合并）。 */
  pendingBannedTags: Array<{ tag: string; revealer: string[] }>;
  /** 同步模式的当前轮次（从 1 开始，每局重置）。非同步模式恒为 1。 */
  syncRound: number;
  /** 同步模式本轮已完成的玩家 id（猜过、超时或投降即完成）。 */
  syncCompletedPlayerIds: string[];
  /** 血战模式按猜对顺序累积的胜者 id（下标 + 1 即名次）。 */
  nonstopWinnerIds: string[];
  /** 血战模式的名次分基数：开局时的参战人数（原版 `nonstopTotalPlayers`）。 */
  nonstopTotalPlayers: number;
  /**
   * 队伍模式的**共享标记串**：队伍号 → 标记。
   *
   * 原版 `currentGame.teamGuesses`。队伍模式下标记不记在个人身上，而是记在这里，
   * 然后**覆盖回每个队友的 `marks`** —— 所以「一次猜测算几次」对全队是同一份账。
   */
  teamMarks: Record<string, string>;
  /**
   * 本局的提示文本，由手动出题的出题人在 `ccb.game.setAnswer` 里给出。
   *
   * 与设置里的 `useHints` 阈值**按序配对**：第 i 条阈值配第 i 条文本。
   * 服务端抽题的局没有出处，恒为空数组。
   */
  hints: string[];
}

/**
 * 房间记录。
 *
 * 与 `SonGuessrRoomRecord` 保持结构对称：`players` 用 id 索引便于 O(1) 查找；
 * `isHost` / `testMode` 一律由 `hostPlayerId` 与房间号派生，不存第二份真相。
 */
export interface CCBRoomRecord {
  roomId: string;
  name: string;
  visibility: RoomVisibility;
  /** 仅私密房间有值；只在内存中做等值比较，不落库、不进日志。 */
  password?: string;
  allowSpectators: boolean;
  hostPlayerId: string;
  settings: CCBGameSettings;
  phase: CCBPhase;
  roundNumber: number;
  players: Record<string, CCBPlayerRecord>;
  chat: ChatMessage[];
  currentRound?: CCBRoundRecord;
  /** 结算后公开的答案卡。增强版由服务端出题，因此只在 `settled` 阶段填充。 */
  revealedAnswer?: CCBAnswerView;
  answerSetterPlayerId?: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  /** 全员离线的起点，用于空房宽限期。 */
  emptySinceAt?: number;
  /** 房主断线后的宽限截止时间，超时即转移房主。 */
  hostReconnectDeadlineAt?: number;
}

// ==================== 客户端消息 ====================

export type CCBClientEnvelope<TType extends string, TPayload> = ClientEnvelope<TType, TPayload>;

export type CCBClientMessage =
  | ClientEnvelope<"ccb.lobby.subscribeRooms", Record<string, never>>
  | ClientEnvelope<
      "ccb.room.create",
      {
        roomId: string;
        name: string;
        visibility: RoomVisibility;
        password?: string;
        allowSpectators: boolean;
        userName: string;
        settings?: Partial<CCBGameSettings>;
      }
    >
  | ClientEnvelope<"ccb.room.join", { userName: string; password?: string }>
  | ClientEnvelope<"ccb.room.reconnect", { roomId: string; sessionToken: string }>
  | ClientEnvelope<"ccb.room.leave", Record<string, never>>
  | ClientEnvelope<"ccb.room.requestSync", Record<string, never>>
  | ClientEnvelope<
      "ccb.room.updateSettings",
      Partial<CCBGameSettings> & {
        name?: string;
        visibility?: RoomVisibility;
        password?: string;
        allowSpectators?: boolean;
      }
    >
  | ClientEnvelope<"ccb.room.kick", { playerId: string }>
  | ClientEnvelope<"ccb.room.transferHost", { playerId: string }>
  | ClientEnvelope<"ccb.player.setReady", { ready: boolean }>
  | ClientEnvelope<"ccb.player.setSpectator", { spectator: boolean }>
  /**
   * 自选队伍（`null` = 不组队，`1..8` = 队伍号）。
   *
   * ⚠️ 与原版的差异：原版用 `team = '0'` 表示观战，本项目**不再复用这个值** ——
   * 观战是 `membership`，两套真相会打架。详见 `Agents/CCB.md §6.9`。
   */
  | ClientEnvelope<"ccb.player.setTeam", { team: number | null }>
  | ClientEnvelope<"ccb.player.setMessage", { message: string }>
  | ClientEnvelope<"ccb.chat.send", { text: string }>
  | ClientEnvelope<"ccb.test.addBot", { count?: number }>
  | ClientEnvelope<"ccb.test.removeBot", { count?: number }>
  | ClientEnvelope<"ccb.character.search", { keyword: string }>
  | ClientEnvelope<"ccb.game.start", Record<string, never>>
  | ClientEnvelope<"ccb.game.chooseSetter", { playerId: string }>
  | ClientEnvelope<"ccb.game.setAnswer", { characterId: number; hints?: string[] }>
  | ClientEnvelope<"ccb.game.guess", { characterId: number }>
  | ClientEnvelope<"ccb.game.surrender", Record<string, never>>
  | ClientEnvelope<"ccb.game.nextRound", Record<string, never>>
  | ClientEnvelope<"ccb.game.finish", Record<string, never>>;

/**
 * 服务端下发的事件名。
 *
 * `roomSnapshot` / `privateState` 必须同步登记进 `transport/StateSync.ts` 的 `STATE_EVENTS`，
 * 否则每次变化都会退化成全量推送，违反 `Spec.md §7` 的 6 Mbps 预算。
 */
export const CCB_STATE_EVENTS = {
  roomSnapshot: "ccb.room.snapshot",
  privateState: "ccb.game.privateState",
  lobbyRooms: "ccb.lobby.rooms",
  roomClosed: "ccb.room.closed",
  roomKicked: "ccb.room.kicked",
} as const;
