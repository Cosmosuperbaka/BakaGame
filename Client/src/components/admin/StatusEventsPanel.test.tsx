import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicStatusEvent } from "@bakagame/shared";
import { StatusEventsPanel } from "./StatusEventsPanel";

const statusEvents = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Api")>()),
  api: { admin: { statusEvents } },
}));

const maintenance: PublicStatusEvent = {
  id: 7,
  kind: "maintenance",
  title: "数据库例行维护",
  body: "凌晨停机升级。",
  status: "scheduled",
  components: ["search"],
  startedAt: Date.parse("2027-01-02T02:00:00+08:00"),
  plannedEndAt: Date.parse("2027-01-02T04:00:00+08:00"),
  resolvedAt: null,
  updatedAt: Date.parse("2027-01-01T00:00:00+08:00"),
};

beforeEach(() => {
  statusEvents.list.mockResolvedValue({ items: [maintenance], total: 1 });
  statusEvents.update.mockResolvedValue(maintenance);
  statusEvents.create.mockResolvedValue(maintenance);
});

afterEach(() => vi.clearAllMocks());

describe("状态事件面板", () => {
  it("新建时可选类型；编辑已有事件时类型只读，进度档位跟着既有类型走", async () => {
    const events = userEvent.setup();
    render(<StatusEventsPanel />);
    await events.click(await screen.findByRole("button", { name: "发布事件" }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radiogroup", { name: "类型" })).toBeInTheDocument();
    await events.click(within(dialog).getByRole("button", { name: "取消" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await events.click(await screen.findByRole("button", { name: "修改" }));
    dialog = await screen.findByRole("dialog");
    // 服务端更新沿用既有类型，界面不能给一个无效或会被拒的切换。
    expect(within(dialog).queryByRole("radiogroup", { name: "类型" })).toBeNull();
    expect(within(dialog).getByText("维护窗口")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "进度" })).toHaveTextContent("计划中");
  });

  it("编辑保存只提交服务端认的字段，不带类型", async () => {
    const events = userEvent.setup();
    render(<StatusEventsPanel />);
    await events.click(await screen.findByRole("button", { name: "修改" }));
    const dialog = await screen.findByRole("dialog");
    await events.click(within(dialog).getByRole("button", { name: "保存修改" }));
    expect(statusEvents.update).toHaveBeenCalledTimes(1);
    const sent = statusEvents.update.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      id: 7,
      status: "scheduled",
      plannedEndAt: maintenance.plannedEndAt,
    });
    expect(sent).not.toHaveProperty("kind");
  });
});
