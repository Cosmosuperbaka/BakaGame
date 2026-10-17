import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountProfile, AdminOverview, AdminRoom, AdminUser, QQLookupStatus } from "@/types";
import { resetAccountStoreForTest, useAccountStore } from "@/stores/UseAccountStore";
import AdminPage from "./AdminPage";

const admin = vi.hoisted(() => ({
  stats: { overview: vi.fn(), sentry: vi.fn() },
  rooms: { list: vi.fn(), close: vi.fn(), kick: vi.fn() },
  users: { list: vi.fn(), get: vi.fn(), ban: vi.fn(), unban: vi.fn(), setRole: vi.fn(), revokeSessions: vi.fn() },
  feedback: { list: vi.fn(), get: vi.fn(), reply: vi.fn(), setStatus: vi.fn() },
  games: { list: vi.fn(), get: vi.fn() },
  audit: { list: vi.fn() },
  qq: { status: vi.fn(), startLogin: vi.fn(), pollLogin: vi.fn(), logout: vi.fn(), refreshNames: vi.fn() },
}));

vi.mock("@/lib/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Api")>()),
  api: { admin },
}));

const profile = (role: AccountProfile["role"]): AccountProfile => ({
  id: "u-admin", name: "管理员", qqNumber: "90001", image: null, showQq: false, role, createdAt: "2026-10-01T00:00:00.000Z",
});

const overview: AdminOverview = {
  users: { total: 12, admins: 1, banned: 2, newToday: 3 },
  feedback: { open: 4, processing: 1, resolved: 0, closed: 0 },
  live: { faker: { rooms: 1, onlinePlayers: 5 }, song: { rooms: 2, onlinePlayers: 3 }, cee: { rooms: 0, onlinePlayers: 0 } },
  daily: [{ day: "2026-10-13", visitors: 40, signedInVisitors: 6, views: 90, newUsers: 3, rounds: { faker: 2, song: 5, cee: 1 }, roundPlayers: 30 }],
  pages: [{ path: "/songuessr", views: 50 }],
  gameRecordDays: 7,
};

const user: AdminUser = {
  id: "u-1", name: "Alice", qqNumber: "10001", image: null, role: "user", banned: false, banReason: null, banExpires: null,
  showQq: false, qqName: "阿狸", createdAt: "2026-10-02T00:00:00.000Z",
};

const room: AdminRoom = {
  game: "faker", roomId: "1234", name: "周末局", phase: "waiting", visibility: "public", hasPassword: false, hidden: false,
  roundNumber: 0, createdAt: "2026-10-13T00:00:00.000Z", lastActiveAt: "2026-10-13T00:05:00.000Z",
  players: [{ id: "p-1", name: "Bob", online: true, membership: "active", host: true, bot: false, userId: null }],
};

const signedOut: QQLookupStatus = { state: "signedOut", uin: null, nickname: null, loggedInAt: null, expiredAt: null };
const active: QQLookupStatus = { state: "active", uin: "12345", nickname: "查询号", loggedInAt: "2026-10-13T00:00:00.000Z", expiredAt: null };

const renderAdmin = (path = "/admin") => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/admin" element={<AdminPage />} /></Routes>
    </MemoryRouter>,
  );
  return userEvent.setup();
};

beforeEach(() => {
  admin.stats.overview.mockResolvedValue(overview);
  admin.stats.sentry.mockResolvedValue({ configured: false, errors24h: null, unresolvedIssues: null, issues: [], transactions: null, warnings: [], fetchedAt: null });
  admin.rooms.list.mockResolvedValue([room]);
  admin.users.list.mockResolvedValue({ items: [user], total: 1 });
  admin.users.get.mockResolvedValue({ ...user, recentGames: [], feedbackCount: 0 });
  admin.qq.status.mockResolvedValue(signedOut);
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
    expect(await within(dialog).findByText("近 7 天没有对局")).toBeInTheDocument();
    await events.click(within(dialog).getByRole("button", { name: "封禁" }));
    const submit = within(dialog).getByRole("button", { name: "封禁并踢下线" });
    expect(submit).toBeDisabled();
    await events.type(within(dialog).getByLabelText("封禁原因"), "刷屏");
    await events.click(submit);
    expect(admin.users.ban).toHaveBeenCalledWith({ userId: "u-1", reason: "刷屏", expiresInHours: 24 });
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

  it("QQ 查询号：扫码后轮询到确认登录，刷新状态", async () => {
    useAccountStore.setState({ status: "signedIn", profile: profile("admin") });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    admin.qq.startLogin.mockResolvedValue({ loginId: "login-1", image: "data:image/png;base64,AA==" });
    admin.qq.pollLogin.mockResolvedValueOnce({ state: "scanned" }).mockResolvedValueOnce({ state: "success", status: active });
    admin.qq.status.mockResolvedValueOnce(signedOut).mockResolvedValue(active);
    renderAdmin("/admin?tab=qq");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("还没有登录查询号")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新全部昵称" })).toBeDisabled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "扫码登录" })); });
    expect(screen.getByAltText("QQ 登录二维码")).toHaveAttribute("src", "data:image/png;base64,AA==");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText("已扫码，请在手机 QQ 上确认登录")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(admin.qq.pollLogin).toHaveBeenCalledTimes(2);
    expect(admin.qq.pollLogin).toHaveBeenLastCalledWith({ loginId: "login-1" });
    expect(screen.queryByAltText("QQ 登录二维码")).not.toBeInTheDocument();
    expect(screen.getByText("已登录查询号 查询号（12345）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新全部昵称" })).toBeEnabled();
  });
});
