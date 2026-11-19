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

  it("筛选按档位换查询条件：进行中只传 active，事件与维护只传 kind", async () => {
    const events = userEvent.setup();
    render(<StatusEventsPanel />);
    const filter = screen.getByRole("radiogroup", { name: "筛选" });
    await screen.findByRole("button", { name: "修改" });
    expect(statusEvents.list).toHaveBeenCalledWith({ limit: 20, offset: 0 });

    await events.click(within(filter).getByRole("radio", { name: "进行中" }));
    await vi.waitFor(() =>
      expect(statusEvents.list).toHaveBeenCalledWith({ active: true, limit: 20, offset: 0 })
    );

    await events.click(within(filter).getByRole("radio", { name: "维护" }));
    await vi.waitFor(() =>
      expect(statusEvents.list).toHaveBeenCalledWith({ kind: "maintenance", limit: 20, offset: 0 })
    );
  });

  it("删除先确认：取消不删，确认后按 id 删除并重新拉列表", async () => {
    statusEvents.remove.mockResolvedValue({});
    const events = userEvent.setup();
    render(<StatusEventsPanel />);
    await events.click(await screen.findByRole("button", { name: "删除" }));
    let dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(`确定删除「${maintenance.title}」？`);

    await events.click(within(dialog).getByRole("button", { name: "取消" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(statusEvents.remove).not.toHaveBeenCalled();

    const before = statusEvents.list.mock.calls.length;
    await events.click(screen.getByRole("button", { name: "删除" }));
    dialog = await screen.findByRole("dialog");
    await events.click(within(dialog).getByRole("button", { name: "删除" }));
    await vi.waitFor(() => expect(statusEvents.remove).toHaveBeenCalledWith({ id: 7 }));
    await vi.waitFor(() => expect(statusEvents.list.mock.calls.length).toBeGreaterThan(before));
  });
});
