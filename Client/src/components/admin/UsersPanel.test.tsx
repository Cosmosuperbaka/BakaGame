import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUser } from "@bakagame/shared";
import { IDLE_SEARCH_MS } from "@/hooks/UseIdleSearch";
import { UsersPanel } from "./UsersPanel";

const users = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));

vi.mock("@/lib/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Api")>()),
  api: { admin: { users } },
}));

const alice: AdminUser = {
  id: "u-1",
  name: "Alice",
  qqNumber: "10001",
  image: null,
  role: "user",
  banned: false,
  banReason: null,
  banExpires: null,
  showQq: false,
  qqName: null,
  badges: [],
  equippedBadge: null,
  createdAt: "2026-10-02T00:00:00.000Z",
};

const lastInput = () => users.list.mock.calls.at(-1)![0] as Record<string, unknown>;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  users.list.mockResolvedValue({ items: [alice], total: 57 });
  // jsdom 没有指针捕获，Radix 下拉的点选会读到它。
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});
afterEach(() => vi.clearAllMocks());

describe("用户列表翻页", () => {
  it("挂载后的搜索防抖计时不会把刚翻到的页弹回第一页", async () => {
    const events = userEvent.setup();
    render(<UsersPanel />);
    await events.click(await screen.findByRole("button", { name: "下一页" }));
    expect(await screen.findByText("21–40 / 57")).toBeInTheDocument();
    await wait(IDLE_SEARCH_MS + 250);
    expect(screen.getByText("21–40 / 57")).toBeInTheDocument();
    expect(lastInput()).toMatchObject({ offset: 20 });
  });

  it("搜索词变化后回到第一页，停止输入前不逐字请求", async () => {
    const events = userEvent.setup();
    render(<UsersPanel />);
    await events.click(await screen.findByRole("button", { name: "下一页" }));
    expect(await screen.findByText("21–40 / 57")).toBeInTheDocument();
    const calls = users.list.mock.calls.length;

    await events.type(screen.getByLabelText("搜索"), "ali");
    expect(users.list.mock.calls.length).toBe(calls);
    await waitFor(() => expect(lastInput()).toMatchObject({ query: "ali", offset: 0 }));
    expect(users.list.mock.calls.length).toBe(calls + 1);
  });

  it("筛选变化回到第一页", async () => {
    const events = userEvent.setup();
    render(<UsersPanel />);
    await events.click(await screen.findByRole("button", { name: "下一页" }));
    expect(await screen.findByText("21–40 / 57")).toBeInTheDocument();
    await events.click(screen.getByRole("combobox", { name: "角色" }));
    await events.click(await screen.findByRole("option", { name: "管理员" }));
    await waitFor(() => expect(lastInput()).toMatchObject({ role: "admin", offset: 0 }));
  });
});
