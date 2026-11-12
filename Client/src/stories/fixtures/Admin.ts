import { createElement } from "react";
import type { Decorator } from "@storybook/react-vite";
import type {
  AccountProfile,
  AdminAntiCheatReview,
  AdminFeedbackDetail,
  AdminOverview,
  AdminRoom,
  AdminRuntimeSetting,
  AdminUser,
  AdminUserDetail,
  QQLookupStatus,
} from "@bakagame/shared";
import { presetAccount, stubApi, type StubReply } from "./Account";

// ==================== 管理后台各面板故事的假数据与假接口 ====================
// 全部虚构：昵称、QQ 号、房间号都是编的，不对应任何真实账号。截图脚本把「当前时间」固定在
// 2027-01-01 12:00（北京时间），这里的时刻都落在它之前的几天里，跨天、跨月都有。

type AdminFeedback = Omit<AdminFeedbackDetail, "content" | "userAgent" | "replies">;

const at = (iso: string) => `${iso}+08:00`;
const ms = (iso: string) => Date.parse(at(iso));

export const ADMIN_PROFILE: AccountProfile = {
  id: "u-admin",
  name: "站长小布丁",
  qqNumber: "100001",
  image: null,
  showQq: false,
  role: "admin",
  badges: [{ kind: "owner", serial: null }],
  equippedBadge: "owner",
  createdAt: at("2026-06-01T09:00:00"),
};

const NAMES = [
  "小布丁",
  "一个昵称起得非常非常长以至于表格放不下的玩家",
  "路人甲",
  "Kotone_Fujita",
  "猫猫",
  "今天也要早睡",
  "番剧考古学家",
  "Q",
  "听前奏就能猜出来的人",
  "月见",
  "anonymous_tester_2026",
  "芝士雪豹",
  "白开水",
  "OP 收藏家",
  "夜猫子",
  "柚子茶",
  "Lain",
  "第三人称",
  "冷笑话大王",
  "末班车",
];

const ref = (index: number) => ({
  id: `u-${index + 1}`,
  name: NAMES[index % NAMES.length],
  qqNumber: String(800_000 + index * 137),
  image: null,
});

// ---------- 用户 ----------

export const ADMIN_USERS: AdminUser[] = Array.from({ length: 57 }, (_, index) => {
  const base = ref(index);
  const banned = index === 2 || index === 9;
  return {
    ...base,
    role: index === 0 || index === 5 ? "admin" : "user",
    banned,
    banReason: banned ? "多次在聊天里刷屏广告" : null,
    banExpires: index === 2 ? at("2027-01-07T20:00:00") : null,
    showQq: index % 3 === 0,
    qqName:
      index % 4 === 3 ? null : `${base.name}${index % 5 === 1 ? "（QQ 昵称也很长很长很长）" : ""}`,
    badges:
      index === 0
        ? [
            { kind: "owner", serial: null },
            { kind: "contributor", serial: null },
            { kind: "pioneer", serial: 1 },
          ]
        : index < 12
          ? [{ kind: "pioneer", serial: index + 1 }]
          : [],
    equippedBadge: index === 0 ? "owner" : index < 12 ? "pioneer" : null,
    createdAt: new Date(ms("2026-12-31T23:40:00") - index * 31 * 3_600_000).toISOString(),
  };
});

const pageOf = <T>(items: T[], input: unknown, limit = 20) => {
  const { offset = 0, limit: size = limit } = (input ?? {}) as { offset?: number; limit?: number };
  return { items: items.slice(offset, offset + size), total: items.length };
};

const GAMES = ["song", "faker", "cee"] as const;

/** 用户详情：信息很全（三枚徽章、封禁中、一串对局）。 */
export const ADMIN_USER_FULL: AdminUserDetail = {
  ...ADMIN_USERS[1],
  banned: true,
  banReason: "在多个房间重复发布同一条引流链接，警告两次未改",
  banExpires: at("2027-01-30T18:00:00"),
  badges: [
    { kind: "contributor", serial: null },
    { kind: "pioneer", serial: 7 },
  ],
  equippedBadge: "contributor",
  recentGames: Array.from({ length: 8 }, (_, index) => ({
    id: `g-u-${index}`,
    game: GAMES[index % 3],
    roomId: `R${String(48_213 + index * 97)}`,
    roundCount: [12, 3, 1, 25, 8, 6, 2, 40][index],
    startedAt: at(`2026-12-${String(30 - index).padStart(2, "0")}T21:00:00`),
    endedAt: at(`2026-12-${String(30 - index).padStart(2, "0")}T21:47:00`),
    players: [],
  })),
  feedbackCount: 4,
};

/** 用户详情：信息很少（刚注册、没徽章、没对局、没查到 QQ 昵称）。 */
export const ADMIN_USER_SPARSE: AdminUserDetail = {
  ...ADMIN_USERS[56],
  qqName: null,
  badges: [],
  equippedBadge: null,
  recentGames: [],
  feedbackCount: 0,
};

/** 用户详情：查看自己的账号（站长本人，不能封禁或改角色）。 */
export const ADMIN_USER_SELF: AdminUserDetail = {
  ...ADMIN_USERS[0],
  id: ADMIN_PROFILE.id,
  name: ADMIN_PROFILE.name,
  recentGames: ADMIN_USER_FULL.recentGames.slice(0, 3),
  feedbackCount: 0,
};

// ---------- 概览 ----------

const DAYS = Array.from({ length: 30 }, (_, index) => {
  const date = new Date(ms("2026-12-02T12:00:00") + index * 86_400_000);
  return date.toISOString().slice(0, 10);
});

export const ADMIN_OVERVIEW: AdminOverview = {
  users: { total: 12_486, admins: 2, banned: 17, newToday: 38 },
  feedback: { open: 9, processing: 3, resolved: 142, closed: 27 },
  live: {
    faker: { rooms: 4, onlinePlayers: 23 },
    song: { rooms: 11, onlinePlayers: 57 },
    cee: { rooms: 2, onlinePlayers: 6 },
  },
  daily: DAYS.map((day, index) => {
    const wave = Math.round(Math.sin(index / 2) * 300);
    return {
      day,
      visitors: 1_800 + wave + index * 41,
      signedInVisitors: 420 + Math.round(wave / 3),
      views: 9_000 + wave * 7 + index * 230,
      newUsers: index === 24 ? 312 : 20 + (index % 9) * 3,
      games: { faker: 30 + (index % 7), song: 120 + index * 3, cee: index % 4 },
      roundPlayers: 2_100 + wave * 2,
    };
  }),
  pages: [
    { path: "/songuessr", views: 48_210 },
    { path: "/", views: 30_115 },
    { path: "/whoisfaker", views: 12_904 },
    { path: "/cee", views: 6_300 },
    { path: "/songuessr/room/R48213?from=lobby&invite=abcdefg", views: 812 },
    { path: "/status", views: 95 },
    { path: "/credits", views: 3 },
  ],
};

const overviewFor = (input: unknown) => {
  const days = (input as { days?: number } | undefined)?.days ?? 14;
  return { ...ADMIN_OVERVIEW, daily: ADMIN_OVERVIEW.daily.slice(-days) };
};

export const ADMIN_SENTRY = {
  configured: true,
  errors24h: 1_284,
  unresolvedIssues: 23,
  issues: [
    {
      id: "s-1",
      shortId: "WEB-3F2",
      title: "TypeError: Cannot read properties of undefined (reading 'lyrics') in SongLyricPlayer",
      culprit: "SongLyricPlayer",
      level: "error",
      count: 932,
      userCount: 211,
      lastSeen: at("2027-01-01T11:52:00"),
      permalink: "https://sentry.example.com/issues/1/",
      project: "web",
    },
    {
      id: "s-2",
      shortId: "SERVER-1A",
      title: "上游搜索超时",
      culprit: null,
      level: "warning",
      count: 40,
      userCount: 12,
      lastSeen: at("2026-12-31T23:10:00"),
      permalink: null,
      project: "server",
    },
    {
      id: "s-3",
      shortId: "SERVER-9C",
      title: "数据库连接池耗尽",
      culprit: null,
      level: "fatal",
      count: 2,
      userCount: 0,
      lastSeen: at("2026-12-29T03:00:00"),
      permalink: "https://sentry.example.com/issues/3/",
      project: "server",
    },
  ],
  transactions: [
    {
      name: "POST /api/rpc/admin/stats/overview",
      project: "server",
      count: 120,
      p75: 84,
      p95: 412,
    },
    { name: "GET /api/song/search", project: "server", count: 18_402, p75: 230, p95: 1_870 },
    {
      name: "WS /ws/songuessr/room/{roomId}/very/long/transaction/name/that/keeps/going",
      project: "server",
      count: 9,
      p75: null,
      p95: 31_200,
    },
  ],
  warnings: ["性能查询超时，接口耗时表只含部分项目"],
  fetchedAt: at("2027-01-01T11:58:00"),
};

export const ADMIN_SENTRY_OFF = {
  configured: false,
  errors24h: null,
  unresolvedIssues: null,
  issues: [],
  transactions: null,
  warnings: [],
  fetchedAt: null,
};

// ---------- 房间 ----------

const player = (
  index: number,
  patch: Partial<AdminRoom["players"][number]> = {}
): AdminRoom["players"][number] => ({
  id: `p-${index}`,
  name: NAMES[index % NAMES.length],
  online: index % 5 !== 3,
  membership: "active",
  host: false,
  bot: false,
  userId: index % 2 ? `u-${index}` : null,
  ...patch,
});

export const ADMIN_ROOMS: AdminRoom[] = [
  {
    game: "song",
    roomId: "R48213",
    name: "周五晚上一起猜 2010 年代番剧 OP，欢迎新人，进来先看公告别直接开麦",
    phase: "playing",
    visibility: "public",
    hasPassword: false,
    hidden: false,
    roundNumber: 17,
    createdAt: at("2026-12-31T21:02:00"),
    lastActiveAt: at("2027-01-01T11:59:00"),
    players: [
      player(0, { host: true }),
      player(1),
      player(2),
      player(3),
      player(4, { membership: "spectator" }),
      player(5),
      player(6, { bot: true, name: "人机·小八" }),
      player(7),
      player(8, { membership: "kicked" }),
      player(9),
      player(10),
      player(11),
    ],
  },
  {
    game: "faker",
    roomId: "F1029",
    name: "卧底局",
    phase: "description",
    visibility: "private",
    hasPassword: true,
    hidden: true,
    roundNumber: 2,
    createdAt: at("2027-01-01T10:15:00"),
    lastActiveAt: at("2027-01-01T11:40:00"),
    players: [player(12, { host: true }), player(13), player(14), player(15)],
  },
  {
    game: "cee",
    roomId: "C77",
    name: "CEE 增强房",
    phase: "waiting",
    visibility: "public",
    hasPassword: false,
    hidden: false,
    roundNumber: 0,
    createdAt: at("2027-01-01T11:55:00"),
    lastActiveAt: at("2027-01-01T11:55:00"),
    players: [],
  },
];

// ---------- 状态事件 ----------

const LONG_BODY =
  "部分地区访问网易云音乐接口超时，猜歌房间的曲目加载会失败并自动跳过。我们已经切换到备用线路，正在观察成功率；" +
  "如果你在房间里连续遇到跳过，可以先换用 QQ 音乐曲库。".repeat(3);

export const ADMIN_STATUS_EVENTS = Array.from({ length: 26 }, (_, index) => {
  const maintenance = index % 3 === 1;
  const active = index < 3;
  const startedAt = ms("2026-12-31T20:00:00") - index * 26 * 3_600_000;
  return {
    id: 300 - index,
    kind: maintenance ? ("maintenance" as const) : ("incident" as const),
    title:
      index === 0
        ? "网易云音乐接口大面积超时，猜歌房间曲目加载失败并会自动跳过到下一首"
        : maintenance
          ? `数据库例行维护（第 ${index} 次）`
          : `搜索索引延迟 ${index}`,
    body: index === 0 ? LONG_BODY : "影响范围有限，已恢复。",
    status: maintenance
      ? active
        ? ("in_progress" as const)
        : ("done" as const)
      : active
        ? ("investigating" as const)
        : ("resolved" as const),
    components:
      index === 0
        ? (["netease", "rooms", "search", "dataset", "images"] as const).slice()
        : index % 4 === 2
          ? []
          : (["search"] as const).slice(),
    startedAt,
    plannedEndAt: maintenance ? startedAt + 2 * 3_600_000 : null,
    resolvedAt: maintenance || active ? null : startedAt + 45 * 60_000,
    updatedAt: startedAt,
  };
});

// ---------- 反馈 ----------

export const ADMIN_FEEDBACK: AdminFeedback[] = Array.from({ length: 33 }, (_, index) => ({
  id: `fb-${index}`,
  kind: index % 3 === 0 ? "bug" : "suggestion",
  title:
    index === 0
      ? "手机上结算页的「再来一局」按钮被底部导航挡住了一半，点了好几次都点不到，希望能修一下"
      : [`希望谁是卧底可以自定义词库`, `猜歌能不能加日语歌`, `房间密码输错没有提示`][index % 3],
  status: (["open", "processing", "resolved", "closed"] as const)[index % 4],
  createdAt: new Date(ms("2027-01-01T09:00:00") - index * 19 * 3_600_000).toISOString(),
  lastReplyAt: index % 4 === 1 ? at("2027-01-01T10:00:00") : null,
  user: index % 5 === 4 ? null : ref(index),
  page: index % 2 ? "/songuessr/room/R48213" : null,
  sentryEventId: index === 0 ? "a1b2c3d4e5f60718293a4b5c6d7e8f90" : null,
}));

export const ADMIN_FEEDBACK_DETAIL: AdminFeedbackDetail = {
  ...ADMIN_FEEDBACK[0],
  status: "processing",
  content:
    "机型是一台 6.1 寸的手机，浏览器竖屏。\n\n结算页滚到底部以后，「再来一局」只露出上半截，下半截被系统手势条盖住。横屏没有这个问题。\n\n截图我发在群里了。",
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  replies: [
    {
      id: 1,
      content: "收到，已经复现，下个版本修。",
      createdAt: at("2027-01-01T10:00:00"),
      author: { id: ADMIN_PROFILE.id, name: ADMIN_PROFILE.name, qqNumber: "100001", image: null },
    },
    {
      id: 2,
      content: "修复已经合入，更新后再看看。",
      createdAt: at("2027-01-01T11:30:00"),
      author: null,
    },
  ],
};

export const ADMIN_FEEDBACK_ANON: AdminFeedbackDetail = {
  ...ADMIN_FEEDBACK[4],
  content: "匿名提的：搜索框能不能支持拼音首字母？",
  userAgent: null,
  replies: [],
};

// ---------- 反作弊复核 ----------

export const ADMIN_REVIEWS: AdminAntiCheatReview[] = Array.from({ length: 24 }, (_, index) => ({
  id: `ac-${index}`,
  roomId: `C${700 + index}`,
  roundNumber: (index % 12) + 1,
  playerName: index === 1 ? NAMES[1] : NAMES[(index * 3) % NAMES.length],
  player: index % 4 === 3 ? null : ref(index),
  clientType: (["web", "desktop", "mobile"] as const)[index % 3],
  score: [92, 7, 45, 120, 61][index % 5],
  reasons:
    index === 0
      ? [
          "相邻猜测间隔几乎恒定（变异系数 0.031）",
          "8 次猜测中 7 次未检索直接提交",
          "首猜即中且用时 1.2 秒",
        ]
      : ["首猜即中", "检索落空 6 次后命中"].slice(0, (index % 2) + 1),
  features: {
    intervals:
      index === 0
        ? [1200, 1210, 1190, 1205, 1198, 1202, 1201, 1199, 1200, 1203, 1197]
        : [3400, 5100],
    cv: index === 0 ? 0.031 : null,
    noSearchGuesses: index === 0 ? 7 : 0,
    unmatchedSearches: index === 0 ? 0 : 6,
    guesses: index === 0 ? 8 : 2,
    firstGuessCorrect: index % 2 === 0,
  },
  status: index < 20 ? "open" : index % 2 ? "cleared" : "actioned",
  createdAt: new Date(ms("2027-01-01T11:00:00") - index * 7 * 3_600_000).toISOString(),
}));

export const ADMIN_REVIEW_HISTORY = {
  windowDays: 30,
  rounds: 14,
  avgGuesses: 3.21,
  firstGuessHits: 9,
  avgCv: 0.084,
  maxScore: 120,
};

// ---------- 对局 ----------

export const ADMIN_GAMES = Array.from({ length: 47 }, (_, index) => ({
  id: `g-${index}`,
  game: GAMES[index % 3],
  roomId: index === 0 ? "R48213-周五番剧OP专场" : `R${48_000 + index * 13}`,
  roundCount: [17, 1, 6, 40, 3][index % 5],
  startedAt: new Date(ms("2027-01-01T10:00:00") - index * 11 * 3_600_000).toISOString(),
  endedAt: new Date(
    ms("2027-01-01T10:00:00") -
      index * 11 * 3_600_000 +
      (index % 5 === 3 ? 7_380_000 : 42_000 + index * 9_000)
  ).toISOString(),
  players: Array.from({ length: index === 0 ? 12 : (index % 6) + 1 }, (_, slot) => ({
    playerId: `p-${slot}`,
    userId: slot % 2 ? `u-${slot}` : null,
    name: NAMES[(index + slot) % NAMES.length],
    score: (12 - slot) * 37,
  })),
}));

export const ADMIN_GAME_DETAIL = {
  ...ADMIN_GAMES[0],
  rounds: Array.from({ length: 6 }, (_, index) => ({
    number: index + 1,
    startedAt: new Date(Date.parse(ADMIN_GAMES[0].startedAt) + index * 300_000).toISOString(),
    endedAt: new Date(
      Date.parse(ADMIN_GAMES[0].startedAt) + index * 300_000 + 95_000
    ).toISOString(),
    players: ADMIN_GAMES[0].players
      .slice(0, 4)
      .map((item, slot) => ({ ...item, score: slot === 3 ? -5 : 10 - slot * 3 })),
    summary: {
      answer: { title: "残酷な天使のテーゼ", artist: "高橋洋子", source: "新世纪福音战士" },
      hintsUsed: index % 3,
      skipped: index === 4,
    },
  })),
  timeline: Array.from({ length: 30 }, (_, index) => ({
    at: Date.parse(ADMIN_GAMES[0].startedAt) + index * 61_000,
    type: ["round.start", "guess", "guess.correct", "player.join", "round.end"][index % 5],
    ...(index % 5 === 4 ? {} : { round: Math.floor(index / 5) + 1 }),
    ...(index % 5 === 1
      ? { player: NAMES[index % NAMES.length], text: "残酷な天使のテーゼ（OP 版）" }
      : {}),
  })),
};

// ---------- 审计 ----------

const AUDIT_ACTIONS = [
  ["user.ban", "user", { reason: "刷屏广告", expiresInHours: 168 }],
  ["room.close", "room", { game: "song", roomId: "R48213" }],
  ["runtimeSetting.update", "runtimeSetting", { key: "clientMinDesktopVersion", value: "0.1.2" }],
  ["feedback.reply", "feedback", { length: 18 }],
  [
    "statusEvent.create",
    "statusEvent",
    { title: LONG_BODY.slice(0, 80), components: ["netease", "rooms"] },
  ],
  ["user.setRole", "user", { role: "admin" }],
  ["qq.refreshNames", "qq", null],
  ["legacy.unknownAction", "misc", { note: "旧版本写入的动作名，没有中文标签" }],
] as const;

export const ADMIN_AUDIT = Array.from({ length: 95 }, (_, index) => {
  const [action, targetType, detail] = AUDIT_ACTIONS[index % AUDIT_ACTIONS.length];
  return {
    id: 5_000 - index,
    actor: index % 6 === 5 ? null : ref(index % 2 ? 0 : 5),
    action,
    targetType,
    targetId:
      targetType === "user"
        ? `u-${index}-a7f3c9e2-41d8-4b6f-9e2a-${String(index).padStart(12, "0")}`
        : `${targetType}-${index}`,
    detail: detail ? { ...detail } : null,
    createdAt: new Date(ms("2027-01-01T11:30:00") - index * 5 * 3_600_000).toISOString(),
  };
});

// ---------- QQ 查询号 ----------

export const QQ_ACTIVE: QQLookupStatus = {
  state: "active",
  uin: "100002",
  nickname: "查询号·小助手",
  checkedAt: at("2027-01-01T11:59:30"),
  error: null,
};

export const QQ_DOWN: QQLookupStatus = {
  state: "unavailable",
  uin: null,
  nickname: null,
  checkedAt: at("2027-01-01T11:59:30"),
  error: "NapCat 未响应：连接被拒绝，请检查实例是否在运行",
};

// ---------- 运行期旋钮 ----------

export const ADMIN_SETTINGS: AdminRuntimeSetting[] = [
  {
    key: "clientMinDesktopVersion",
    title: "桌面客户端最低版本",
    note: "低于该版本的桌面客户端进反作弊房时提示更新；普通房间不受影响。",
    envVar: "CLIENT_MIN_DESKTOP_VERSION",
    kind: "version",
    defaultValue: "0.1.0",
    storedValue: "0.1.2",
    effectiveValue: "0.1.2",
    updatedAt: at("2026-12-28T22:10:00"),
    updatedBy: ADMIN_PROFILE.name,
  },
  {
    key: "clientMinMobileVersion",
    title: "移动客户端最低版本",
    note: "同上，对移动客户端生效。",
    envVar: "CLIENT_MIN_MOBILE_VERSION",
    kind: "version",
    defaultValue: "",
    storedValue: "abc",
    effectiveValue: "",
    updatedAt: at("2026-11-02T08:00:00"),
    updatedBy: null,
  },
  {
    key: "enableGeneralUnblock",
    title: "通用解锁",
    note: "关闭后不再为海外线路提供曲目代理。",
    envVar: "ENABLE_GENERAL_UNBLOCK",
    kind: "boolean",
    defaultValue: "true",
    storedValue: null,
    effectiveValue: "true",
    updatedAt: null,
    updatedBy: null,
  },
  {
    key: "enableFakerEntry",
    title: "谁是卧底入口",
    note: "临时关闭谁是卧底的创建与加入入口，已在进行的房间不受影响。",
    envVar: null,
    kind: "boolean",
    defaultValue: "true",
    storedValue: "false",
    effectiveValue: "false",
    updatedAt: at("2027-01-01T09:30:00"),
    updatedBy: ADMIN_PROFILE.name,
  },
  {
    key: "enableCeeMultiplayerEntry",
    title: "CEE 多人入口",
    note: "临时关闭 CEE 多人模式。",
    envVar: null,
    kind: "boolean",
    defaultValue: "true",
    storedValue: null,
    effectiveValue: "true",
    updatedAt: null,
    updatedBy: null,
  },
];

// ---------- 接口桩 ----------

/** 有数据时的全部后台接口；故事按需覆盖其中几项（如改成 "pending"、"error" 或空列表）。 */
export const ADMIN_ROUTES: Record<string, StubReply> = {
  "admin/stats/overview": overviewFor,
  "admin/stats/sentry": ADMIN_SENTRY,
  "admin/antiCheat/list": (input: unknown) => {
    const status = (input as { status?: string } | undefined)?.status;
    return pageOf(
      status ? ADMIN_REVIEWS.filter((item) => item.status === status) : ADMIN_REVIEWS,
      input
    );
  },
  "admin/antiCheat/history": ADMIN_REVIEW_HISTORY,
  "admin/antiCheat/setStatus": null,
  "admin/rooms/list": ADMIN_ROOMS,
  "admin/rooms/close": null,
  "admin/rooms/kick": null,
  "admin/statusEvents/list": (input: unknown) => pageOf(ADMIN_STATUS_EVENTS, input),
  "admin/users/list": (input: unknown) => pageOf(ADMIN_USERS, input),
  "admin/users/get": (input: unknown) => {
    const id = (input as { userId?: string } | undefined)?.userId;
    if (id === ADMIN_USER_FULL.id) return ADMIN_USER_FULL;
    if (id === ADMIN_USER_SELF.id) return ADMIN_USER_SELF;
    return ADMIN_USER_SPARSE;
  },
  "admin/feedback/list": (input: unknown) => {
    const status = (input as { status?: string } | undefined)?.status;
    return pageOf(
      status ? ADMIN_FEEDBACK.filter((item) => item.status === status) : ADMIN_FEEDBACK,
      input
    );
  },
  "admin/feedback/get": (input: unknown) =>
    (input as { id?: string } | undefined)?.id === ADMIN_FEEDBACK_DETAIL.id
      ? ADMIN_FEEDBACK_DETAIL
      : ADMIN_FEEDBACK_ANON,
  "admin/games/list": (input: unknown) => {
    const room = (input as { roomId?: string } | undefined)?.roomId;
    return pageOf(room ? ADMIN_GAMES.filter((item) => item.roomId === room) : ADMIN_GAMES, input);
  },
  "admin/games/get": ADMIN_GAME_DETAIL,
  "admin/audit/list": (input: unknown) => pageOf(ADMIN_AUDIT, input, 30),
  "admin/qq/status": QQ_ACTIVE,
  "admin/qq/refreshNames": { checked: 200, updated: 37, remaining: 1_204 },
  "admin/settings/list": { items: ADMIN_SETTINGS },
  "admin/settings/set": { items: ADMIN_SETTINGS },
  "admin/bangumiMirror/status": "pending",
};

/** 以管理员身份登录并桩住后台接口；`overrides` 覆盖个别接口。返回还原函数。 */
export function installAdmin(overrides: Record<string, StubReply> = {}): () => void {
  const restoreAccount = presetAccount({ status: "signedIn", profile: ADMIN_PROFILE });
  const restoreApi = stubApi({ ...ADMIN_ROUTES, ...overrides });
  return () => {
    restoreApi();
    restoreAccount();
  };
}

/** 面板放进与后台页同宽同内边距的容器里截图。 */
export const adminPanelFrame: Decorator = (Story) =>
  createElement(
    "div",
    { className: "mx-auto w-full max-w-6xl px-6 pb-10 pt-6 md:px-10" },
    createElement(Story)
  );
