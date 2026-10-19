import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountProfile,
  AdminAntiCheatReview,
  AdminOverview,
  AdminRoom,
  AdminUser,
  QQLookupStatus,
} from "@/types";
import { resetAccountStoreForTest, useAccountStore } from "@/stores/UseAccountStore";
import AdminPage from "./AdminPage";

const admin = vi.hoisted(() => ({
  stats: { overview: vi.fn(), sentry: vi.fn() },
  rooms: { list: vi.fn(), close: vi.fn(), kick: vi.fn() },
  users: {
    list: vi.fn(),
    get: vi.fn(),
    ban: vi.fn(),
    unban: vi.fn(),
    setRole: vi.fn(),
    revokeSessions: vi.fn(),
  },
  feedback: { list: vi.fn(), get: vi.fn(), reply: vi.fn(), setStatus: vi.fn() },
  antiCheat: { list: vi.fn(), setStatus: vi.fn() },
  games: { list: vi.fn(), get: vi.fn() },
  audit: { list: vi.fn() },
  qq: { status: vi.fn(), refreshNames: vi.fn() },
}));

vi.mock("@/lib/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Api")>()),
  api: { admin },
}));

const profile = (role: AccountProfile["role"]): AccountProfile => ({
  id: "u-admin",
  name: "管理员",
  qqNumber: "90001",
  image: null,
  showQq: false,
  role,
  createdAt: "2026-10-01T00:00:00.000Z",
});

const overview: AdminOverview = {
  users: { total: 12, admins: 1, banned: 2, newToday: 3 },
  feedback: { open: 4, processing: 1, resolved: 0, closed: 0 },
  live: {
    faker: { rooms: 1, onlinePlayers: 5 },
    song: { rooms: 2, onlinePlayers: 3 },
    cee: { rooms: 0, onlinePlayers: 0 },
  },
  daily: [
    {
      day: "2026-10-13",
      visitors: 40,
      signedInVisitors: 6,
      views: 90,
      newUsers: 3,
      games: { faker: 2, song: 5, cee: 1 },
      roundPlayers: 30,
    },
  ],
  pages: [{ path: "/songuessr", views: 50 }],
};

const user: AdminUser = {
  id: "u-1",
  name: "Alice",
  qqNumber: "10001",
  image: null,
  role: "user",
  banned: false,
  banReason: null,
  banExpires: null,
  showQq: false,
  qqName: "阿狸",
  createdAt: "2026-10-02T00:00:00.000Z",
};

const room: AdminRoom = {
  game: "faker",
  roomId: "1234",
  name: "周末局",
  phase: "waiting",
  visibility: "public",
  hasPassword: false,
  hidden: false,
  roundNumber: 0,
  createdAt: "2026-10-13T00:00:00.000Z",
  lastActiveAt: "2026-10-13T00:05:00.000Z",
  players: [
    {
      id: "p-1",
      name: "Bob",
      online: true,
      membership: "active",
      host: true,
      bot: false,
      userId: null,
    },
  ],
};

const unavailable: QQLookupStatus = {
  state: "unavailable",
  uin: null,
  nickname: null,
  checkedAt: "2026-10-13T00:00:00.000Z",
  error: "NapCat 当前没有登录任何 QQ 号",
};
const active: QQLookupStatus = {
  state: "active",
  uin: "12345",
  nickname: "查询号",
  checkedAt: "2026-10-13T00:00:00.000Z",
  error: null,
};

const review: AdminAntiCheatReview = {
  id: "rev-1",
  roomId: "ABCD",
  roundNumber: 3,
  playerName: "Bob",
  player: { id: "u-1", name: "Alice", qqNumber: "10001", image: null },
  clientType: "mobile",
  score: 4,
  reasons: ["节奏恒定（间隔变异系数 0.012）", "未检索直接猜（4/4 次）"],
  features: {
    intervals: [800, 790, 810, 795],
    cv: 0.012,
    noSearchGuesses: 4,
    unmatchedSearches: 0,
    guesses: 4,
    firstGuessCorrect: true,
  },
  status: "open",
  createdAt: "2026-10-18T10:05:00.000Z",
};

const renderAdmin = (path = "/admin") => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin" element={<AdminPage />} />
      </Routes>
    </MemoryRouter>
  );
  return userEvent.setup();
};

beforeEach(() => {
  admin.stats.overview.mockResolvedValue(overview);
  admin.stats.sentry.mockResolvedValue({
    configured: false,
    errors24h: null,
    unresolvedIssues: null,
    issues: [],
    transactions: null,
    warnings: [],
    fetchedAt: null,
  });
  admin.rooms.list.mockResolvedValue([room]);
  admin.users.list.mockResolvedValue({ items: [user], total: 1 });
  admin.users.get.mockResolvedValue({ ...user, recentGames: [], feedbackCount: 0 });
  admin.qq.status.mockResolvedValue(unavailable);
  // 概览会读一条待复核计数；默认给空队列，需要条数的用例各自覆盖。
  admin.antiCheat.list.mockResolvedValue({ items: [], total: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  resetAccountStoreForTest();
});

describe("管理后台", () => {
  it("游客看到登录提示，普通用户看到无权限，都不请求后台接口", () => {
    useAccountStore.setState({ status: "guest", profile: null });
    renderAdmin();
    expect(screen.getByRole("heading", { name: "请先登录" })).toBeInTheDocument();
    act(() => useAccountStore.setState({ status: "signedIn", profile: profile("user") }));
    expect(screen.getByRole("heading", { name: "没有访问权限" })).toBeInTheDocument();
    expect(admin.stats.overview).not.toHaveBeenCalled();
  });

  it("管理员默认进入概览：汇总、每日数据与未配置的 Sentry", async () => {
    useAccountStore.setState({ status: "signedIn", profile: profile("admin") });
    renderAdmin();
    expect(await screen.findByText("注册账号")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    const daily = screen.getByRole("table", { name: "每日数据" });
    expect(within(daily).getByText("10-13")).toBeInTheDocument();
    expect(within(daily).getByText("8")).toBeInTheDocument();
    expect(await screen.findByText(/未配置 SENTRY_API_TOKEN/)).toBeInTheDocument();
    expect(admin.stats.overview).toHaveBeenCalledWith({ days: 14 });
  });

  it("用户列表展示 QQ 昵称，点开详情可以封禁", async () => {
    useAccountStore.setState({ status: "signedIn", profile: profile("admin") });
    admin.users.ban.mockResolvedValue({ ...user, banned: true });
    const events = renderAdmin("/admin?tab=users");
    const table = await screen.findByRole("table", { name: "用户列表" });
    expect(within(table).getByText("阿狸")).toBeInTheDocument();

    await events.click(within(table).getByRole("button", { name: /Alice/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("还没有对局记录")).toBeInTheDocument();
    await events.click(within(dialog).getByRole("button", { name: "封禁" }));
    const submit = within(dialog).getByRole("button", { name: "封禁并踢下线" });
    expect(submit).toBeDisabled();
    await events.type(within(dialog).getByLabelText("封禁原因"), "刷屏");
    await events.click(submit);
    expect(admin.users.ban).toHaveBeenCalledWith({
      userId: "u-1",
      reason: "刷屏",
      expiresInHours: 24,
    });
  });

  it("关闭房间需要确认，失败文案留在确认框内", async () => {
    useAccountStore.setState({ status: "signedIn", profile: profile("admin") });
    admin.rooms.close.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ ok: true });
    const events = renderAdmin("/admin?tab=rooms");
    await events.click(await screen.findByRole("button", { name: "关闭房间" }));
    const dialog = await screen.findByRole("dialog");
    await events.click(within(dialog).getByRole("button", { name: "关闭房间" }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    await events.click(within(dialog).getByRole("button", { name: "关闭房间" }));
    expect(admin.rooms.close).toHaveBeenLastCalledWith({ game: "faker", roomId: "1234" });
    expect(admin.rooms.list).toHaveBeenCalledTimes(2);
  });

  it("对局记录一房一行，详情按回合展开并合并时间线", async () => {
    useAccountStore.setState({ status: "signedIn", profile: profile("admin") });
    const startedAt = "2026-10-13T00:00:00.000Z";
    const listed = {
      id: "rec-1",
      game: "song",
      roomId: "ABCD",
      roundCount: 2,
      startedAt,
      endedAt: "2026-10-13T00:20:00.000Z",
      players: [{ playerId: "p-1", userId: null, name: "Bob", score: 3 }],
    };
    admin.games.list.mockResolvedValue({ items: [listed], total: 1 });
    admin.games.get.mockResolvedValue({
      ...listed,
      rounds: [
        {
          number: 1,
          startedAt,
          endedAt: "2026-10-13T00:05:00.000Z",
          players: [{ playerId: "p-1", userId: null, name: "Bob", score: 1 }],
          summary: { song: { title: "曲目一" } },
        },
        {
          number: 2,
          startedAt: "2026-10-13T00:06:00.000Z",
          endedAt: "2026-10-13T00:10:00.000Z",
          players: [{ playerId: "p-1", userId: null, name: "Bob", score: 2 }],
          summary: { song: { title: "曲目二" } },
        },
      ],
      timeline: [
        {
          at: Date.parse(startedAt) + 60_000,
          type: "guess",
          round: 1,
          name: "Bob",
          result: "wrong",
        },
      ],
    });

    const events = renderAdmin("/admin?tab=games");
    const table = await screen.findByRole("table", { name: "对局列表" });
    await events.click(within(table).getByRole("button", { name: /2 回合/ }));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("回合（2）")).toBeInTheDocument();
    expect(within(dialog).getAllByText(/第 1 回合/).length).toBeGreaterThan(0);
    expect(within(dialog).getByText("本局总分")).toBeInTheDocument();
    expect(admin.games.get).toHaveBeenCalledWith({ id: "rec-1" });
  });

  it("QQ 昵称来源：显示 NapCat 在线状态，可刷新全部昵称", async () => {
    useAccountStore.setState({ status: "signedIn", profile: profile("admin") });
    admin.qq.status.mockResolvedValue(active);
    admin.qq.refreshNames.mockResolvedValue({ checked: 3, updated: 1, remaining: 0 });
    const events = renderAdmin("/admin?tab=qq");
    expect(await screen.findByText("查询号")).toBeInTheDocument();
    expect(screen.getByText("12345")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新全部昵称" })).toBeEnabled();

    await events.click(screen.getByRole("button", { name: "刷新全部昵称" }));
    expect(admin.qq.refreshNames).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/已检查 3 个账号，更新 1 个昵称/)).toBeInTheDocument();
  });

  it("QQ 昵称来源：不可用时给出原因并禁用刷新", async () => {
    useAccountStore.setState({ status: "signedIn", profile: profile("admin") });
    admin.qq.status.mockResolvedValue(unavailable);
    renderAdmin("/admin?tab=qq");
    expect(await screen.findByText("NapCat 当前没有登录任何 QQ 号")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新全部昵称" })).toBeDisabled();
  });

  it("复核队列按状态列出，处置失败留在弹窗内、成功后重新拉取", async () => {
    useAccountStore.setState({ status: "signedIn", profile: profile("admin") });
    admin.antiCheat.list.mockResolvedValue({ items: [review], total: 1 });
    admin.antiCheat.setStatus.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({
      ok: true,
    });
    const events = renderAdmin("/admin?tab=anticheat");
    const table = await screen.findByRole("table", { name: "复核队列" });
    expect(admin.antiCheat.list).toHaveBeenCalledWith({ status: "open", limit: 20, offset: 0 });
    expect(within(table).getByText("移动端")).toBeInTheDocument();
    expect(
      within(table).getByText("节奏恒定（间隔变异系数 0.012）；未检索直接猜（4/4 次）")
    ).toBeInTheDocument();

    await events.click(within(table).getByRole("button", { name: "Bob" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("未检索直接猜（4/4 次）")).toBeInTheDocument();
    expect(within(dialog).getByText("0.012")).toBeInTheDocument();

    await events.click(within(dialog).getByRole("button", { name: "标记放行" }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(admin.antiCheat.list).toHaveBeenCalledTimes(1);

    await events.click(within(dialog).getByRole("button", { name: "标记放行" }));
    expect(admin.antiCheat.setStatus).toHaveBeenCalledWith({ id: "rev-1", status: "cleared" });
    expect(admin.antiCheat.list).toHaveBeenCalledTimes(2);
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("概览显示待复核条数，点去复核切到反作弊标签", async () => {
    useAccountStore.setState({ status: "signedIn", profile: profile("admin") });
    admin.antiCheat.list.mockResolvedValue({ items: [], total: 3 });
    const events = renderAdmin();

    const label = await screen.findByText("反作弊待复核");
    expect(within(label.parentElement as HTMLElement).getByText("3")).toBeInTheDocument();
    // 概览只要条数：分页与筛选留给复核队列，这里只取一条。
    expect(admin.antiCheat.list).toHaveBeenCalledWith({ status: "open", limit: 1 });

    await events.click(screen.getByRole("button", { name: "去复核" }));
    // 标题旁带队列总数，accessible name 是「反作弊复核 3」，按前缀匹配。
    expect(await screen.findByRole("heading", { name: /^反作弊复核/ })).toBeInTheDocument();
  });
});
