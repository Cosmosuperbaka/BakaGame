import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import StatusPage from "./StatusPage";

const snapshot = {
  observedAt: 1_760_000_000_000,
  level: "degraded",
  version: "V1.2.3（abcdef1）",
  components: [
    { id: "frontend", level: "operational", latencyMs: null },
    { id: "backend", level: "operational", latencyMs: null },
    { id: "bangumi", level: "operational", latencyMs: 180 },
    { id: "qqmusic", level: "degraded", latencyMs: null },
    { id: "netease", level: "operational", latencyMs: 220 },
    { id: "qq", level: "unknown", latencyMs: null },
    { id: "rooms", level: "operational", latencyMs: null },
    { id: "search", level: "degraded", latencyMs: null },
    { id: "dataset", level: "operational", latencyMs: null },
    { id: "images", level: "operational", latencyMs: null },
  ],
};

const history = {
  days: 3,
  generatedAt: 1_760_000_000_000,
  entries: [
    {
      id: "backend",
      uptime: [{ days: 30, ratio: 1 }],
      cells: [
        { day: "2026-10-21", total: 12, ratio: 1, level: "operational" },
        { day: "2026-10-22", total: 12, ratio: 0.4, level: "degraded" },
        { day: "2026-10-23", total: 0, ratio: null, level: "unknown" },
      ],
    },
    {
      id: "bangumi",
      uptime: [{ days: 30, ratio: null }],
      cells: [],
    },
  ],
};

/** 两个有样本的 3 分钟格（起点对齐采样间隔），其余时段由页面补空。 */
const LAST_BUCKET = Math.floor(1_760_000_000_000 / 180_000) * 180_000;
const realtime = {
  intervalMs: 180_000,
  windowMs: 21_600_000,
  generatedAt: 1_760_000_000_000,
  entries: [
    {
      id: "bangumi",
      uptime: 0.5,
      cells: [
        { start: LAST_BUCKET, total: 2, ratio: 1, level: "operational", latencyMs: 150 },
        { start: LAST_BUCKET - 180_000, total: 1, ratio: 0, level: "degraded", latencyMs: null },
      ],
    },
    {
      id: "search",
      uptime: null,
      cells: [],
    },
  ],
};

const events = {
  generatedAt: 1_760_000_000_000,
  events: [
    {
      id: 1,
      kind: "incident",
      title: "搜索索引不可用",
      body: "Meilisearch 重启中，搜索暂时降级。",
      status: "investigating",
      components: ["search"],
      startedAt: 1_759_999_000_000,
      plannedEndAt: null,
      resolvedAt: null,
      updatedAt: 1_759_999_000_000,
    },
    {
      id: 2,
      kind: "maintenance",
      title: "数据库例行维护",
      body: "迁移到新实例，预计两小时。",
      status: "done",
      components: [],
      startedAt: 1_759_000_000_000,
      plannedEndAt: 1_759_003_600_000,
      resolvedAt: 1_759_003_600_000,
      updatedAt: 1_759_003_600_000,
    },
  ],
};

/** fetch 按路径分发三份数据；页面初始加载与分钟轮询都走它。 */
const stubStatusFetch = (
  overrides: Partial<Record<"status" | "history" | "realtime" | "events", unknown>> = {}
) => {
  const bodies: Record<string, unknown> = {
    "/api/status": snapshot,
    "/api/status/history": history,
    "/api/status/realtime": realtime,
    "/api/status/events": events,
    ...Object.fromEntries(
      Object.entries(overrides).map(([key, value]) => [`/api/status/${key}`, value])
    ),
  };
  return vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    const match = Object.keys(bodies)
      .sort((left, right) => right.length - left.length)
      .find((path) => url.endsWith(path));
    const body = match ? bodies[match] : null;
    if (body === null || body === undefined) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
};

/** 实时通道替身：记录每个连接，测试自己决定何时 open / 推帧。 */
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  static latest(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1];
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  fireOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  fireMessage(body: unknown): void {
    this.onmessage?.({ data: JSON.stringify(body) });
  }
  fireClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const stubSocket = () => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
};

/** 让页面按「通道已连上并推了一帧」的形态工作。 */
const connectAndPush = (body: unknown = snapshot) => {
  act(() => {
    FakeSocket.latest().fireOpen();
    FakeSocket.latest().fireMessage(body);
  });
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <StatusPage />
    </MemoryRouter>
  );

const rowOf = (label: string) => screen.getByText(label).closest("li") as HTMLElement;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("公开状态页", () => {
  it("连上实时通道后由推送驱动渲染，页头不再有刷新按钮与连接指示", async () => {
    stubSocket();
    vi.stubGlobal("fetch", stubStatusFetch());
    renderPage();

    expect(await screen.findByText("正在读取服务状态…")).toBeInTheDocument();
    connectAndPush();

    expect(await screen.findByText("2 项服务异常")).toBeInTheDocument();
    // 手动刷新与连接指示已随自动更新移除：通道断了也不再把「连接状态」摆到页头。
    expect(screen.queryByRole("button", { name: /刷新/ })).not.toBeInTheDocument();
    expect(screen.queryByText("已断开")).not.toBeInTheDocument();
    expect(screen.queryByText("连接中")).not.toBeInTheDocument();
  });

  it("上游接口拆成四行各自显示状态与延迟，三组分开渲染", async () => {
    stubSocket();
    vi.stubGlobal("fetch", stubStatusFetch());
    renderPage();
    connectAndPush();
    await screen.findByText("2 项服务异常");

    const platform = screen.getByRole("region", { name: "服务整体" });
    const upstream = screen.getByRole("region", { name: "上游接口" });
    const internal = screen.getByRole("region", { name: "本项目内部服务" });
    expect(within(platform).getByText("前端站点")).toBeInTheDocument();
    expect(within(platform).queryByText("Bangumi API")).not.toBeInTheDocument();
    expect(within(upstream).getByText("Bangumi API")).toBeInTheDocument();
    expect(within(upstream).getByText("QQ音乐 API")).toBeInTheDocument();
    expect(within(upstream).getByText("网易云音乐 API")).toBeInTheDocument();
    expect(within(upstream).getByText("QQ API")).toBeInTheDocument();
    expect(within(internal).getByText("图片缓存")).toBeInTheDocument();

    // 实时视图带当前延迟：上游组件有读数，内部组件读作「—」。
    expect(within(rowOf("Bangumi API")).getByText("180 ms")).toBeInTheDocument();
    expect(within(rowOf("后端服务")).getAllByText("—").length).toBeGreaterThan(0);
    expect(within(rowOf("QQ音乐 API")).getByText("异常")).toBeInTheDocument();
    expect(within(rowOf("QQ API")).getByText("未知")).toBeInTheDocument();
  });

  it("实时与一月两个视图切换：条带、可用率口径与延迟随之换", async () => {
    stubSocket();
    vi.stubGlobal("fetch", stubStatusFetch());
    renderPage();
    connectAndPush();
    await screen.findByText("2 项服务异常");

    // 实时视图：可用率读近 6 小时窗口，上游延迟来自快照。
    expect(screen.getByText("近 6 小时全站可用率")).toBeInTheDocument();
    expect(await within(rowOf("Bangumi API")).findByText("50.00%")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "一月" }));
    });
    expect(screen.getByText("30 天全站可用率")).toBeInTheDocument();
    // 月视图没有「当前延迟」这个口径：Bangumi 行不再显示 180 ms。
    expect(within(rowOf("Bangumi API")).queryByText("180 ms")).not.toBeInTheDocument();
    expect(await within(rowOf("后端服务")).findByText("100.0%")).toBeInTheDocument();
  });

  it("悬停条格显示该时段的可用率、延迟与压在时段上的事件", async () => {
    stubSocket();
    vi.stubGlobal("fetch", stubStatusFetch());
    renderPage();
    connectAndPush();
    await screen.findByText("2 项服务异常");

    // Bangumi 行最新一格正常带延迟，上一格异常没有延迟读数。
    const row = rowOf("Bangumi API");
    const bar = await within(row).findByRole("img", { name: /2 个时段有数据/ });
    const cells = bar.querySelectorAll("span");
    expect(cells.length).toBe(120);
    act(() => {
      fireEvent.pointerEnter(cells[cells.length - 1]!);
    });
    expect(await screen.findByText("正常 · 可用率 100.0%")).toBeInTheDocument();
    expect(screen.getByText("平均延迟 150 ms")).toBeInTheDocument();
    act(() => {
      fireEvent.pointerEnter(cells[cells.length - 2]!);
    });
    expect(await screen.findByText("异常 · 可用率 0.00%")).toBeInTheDocument();
    // 异常格没有延迟读数：上一格的「平均延迟」沿退场动画离开。
    await waitFor(() => expect(screen.queryByText("平均延迟 150 ms")).not.toBeInTheDocument());

    // 进行中的事件压在受影响的搜索行：连空格的悬停说明也带事件标题。
    const internal = screen.getByRole("region", { name: "本项目内部服务" });
    const searchRow = within(internal).getByText("搜索索引").closest("li") as HTMLElement;
    const searchBar = within(searchRow).getByRole("img", {
      name: "这段时间还没有探测样本",
    });
    const searchCells = searchBar.querySelectorAll("span");
    // 最新一格落在事件开始之后，悬停它才带事件标题。
    act(() => {
      fireEvent.pointerEnter(searchCells[searchCells.length - 1]!);
    });
    const emptyNote = await screen.findByText("没有探测样本");
    const tooltip = emptyNote.closest("div")!;
    expect(within(tooltip).getByText("搜索索引不可用")).toBeInTheDocument();

    act(() => {
      fireEvent.pointerLeave(searchBar.parentElement!);
    });
    // 说明沿原路收回需要一拍：等它真正离开文档。
    await waitFor(() => expect(screen.queryByText("没有探测样本")).not.toBeInTheDocument());
  });

  it("事件与维护分开展示：进行中的成卡，已结束的排进时间线", async () => {
    stubSocket();
    vi.stubGlobal("fetch", stubStatusFetch());
    renderPage();
    connectAndPush();

    const card = (await screen.findByText("搜索索引不可用")).closest("article");
    expect(card).not.toBeNull();
    expect(within(card!).getByText("调查中")).toBeInTheDocument();
    expect(within(card!).getByText(/Meilisearch 重启中/)).toBeInTheDocument();
    expect(within(card!).getByText("搜索索引")).toBeInTheDocument();
    // 已结束的维护进时间线，带「已完成」状态。
    const section = screen.getByRole("region", { name: "事件与维护" });
    expect(within(section).getByText("数据库例行维护")).toBeInTheDocument();
    expect(within(section).getAllByText("已完成")).toHaveLength(1);
  });

  it("历史与实时读不到时页面照常显示当前状态，可用率显示「—」", async () => {
    stubSocket();
    vi.stubGlobal("fetch", stubStatusFetch({ history: null, realtime: null, events: null }));
    renderPage();
    connectAndPush();

    expect(await screen.findByText("2 项服务异常")).toBeInTheDocument();
    for (const bar of screen.getAllByRole("img", { name: "这段时间还没有探测样本" })) {
      expect(bar).toBeInTheDocument();
    }
    // 读不到窗口数据时可用率没有样本，读作「—」而不是 0%。
    expect(screen.getByText("近 6 小时全站可用率")).toBeInTheDocument();
    const summary = screen.getByText("近 6 小时全站可用率").closest("p");
    expect(summary).not.toBeNull();
    expect(within(summary!).getByText("—")).toBeInTheDocument();
    expect(screen.getByText("近一个月没有记录在案的事件或维护。")).toBeInTheDocument();
  });
});
