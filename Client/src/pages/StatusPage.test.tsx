import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import StatusPage from "./StatusPage";

const payload = {
  observedAt: 1_760_000_000_000,
  level: "degraded",
  version: "V1.2.3（abcdef1）",
  components: [
    { id: "frontend", level: "operational" },
    { id: "backend", level: "operational" },
    { id: "upstream", level: "unknown" },
    { id: "rooms", level: "operational" },
    { id: "search", level: "degraded" },
    { id: "dataset", level: "operational" },
    { id: "images", level: "operational" },
  ],
};

const history = {
  days: 3,
  generatedAt: 1_760_000_000_000,
  entries: [
    {
      id: "backend",
      uptime: [
        { days: 7, ratio: 1 },
        { days: 30, ratio: 1 },
        { days: 90, ratio: 1 },
      ],
      cells: [
        { day: "2026-10-21", total: 12, ratio: 1, level: "operational" },
        { day: "2026-10-22", total: 12, ratio: 0.4, level: "degraded" },
        { day: "2026-10-23", total: 0, ratio: null, level: "unknown" },
      ],
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** fetch 的第一个入参有三种形状，逐个转成可比对的 URL 字符串。 */
type FetchInput = string | URL | Request;
const calledUrls = (mock: { mock: { calls: unknown[][] } }): string[] =>
  mock.mock.calls.map(([input]) => {
    const value = input as FetchInput;
    if (typeof value === "string") return value;
    if (value instanceof URL) return value.href;
    return value.url;
  });

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
const connectAndPush = (body: unknown = payload) => {
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
});

describe("公开状态页", () => {
  it("连上实时通道后由推送驱动渲染，并按两组分别标注等级", async () => {
    stubSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(history))
    );
    renderPage();

    // 首帧未到之前只在读取，不替服务下任何结论。
    expect(await screen.findByText("正在读取服务状态…")).toBeInTheDocument();
    connectAndPush();

    expect(await screen.findByText("1 项服务异常")).toBeInTheDocument();
    expect(within(rowOf("后端服务")).getByText("正常")).toBeInTheDocument();
    expect(within(rowOf("搜索索引")).getByText("异常")).toBeInTheDocument();
    expect(within(rowOf("上游可用性")).getByText("未知")).toBeInTheDocument();

    // 两组各自成段：服务整体与本项目内部服务分开放。
    const platform = screen.getByRole("region", { name: "服务整体" });
    const internal = screen.getByRole("region", { name: "本项目内部服务" });
    expect(within(platform).getByText("前端站点")).toBeInTheDocument();
    expect(within(internal).getByText("图片缓存")).toBeInTheDocument();
    expect(within(platform).queryByText("房间服务")).not.toBeInTheDocument();
  });

  it("渲染日格条带与 90 天可用率，没有样本的一天不读作 0%", async () => {
    stubSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(history))
    );
    renderPage();
    connectAndPush();

    const bar = await screen.findByRole("img", { name: /2 天有数据，其中 1 天正常、1 天异常/ });
    expect(bar.children).toHaveLength(3);
    // 后端这一行有样本，读得出百分比；其余组件没有历史，读作「—」而不是 0%。
    expect(within(rowOf("后端服务")).getByText("100.0%")).toBeInTheDocument();
    expect(within(rowOf("搜索索引")).getByText("—")).toBeInTheDocument();
  });

  it("通道断开时保留最后一次读到的状态，并说明它不再更新", async () => {
    stubSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(history))
    );
    renderPage();
    connectAndPush();
    await screen.findByText("1 项服务异常");

    act(() => {
      FakeSocket.latest().fireClose();
    });

    expect(await screen.findByText("已断开")).toBeInTheDocument();
    // 断开不等于服务挂了：快照留在页面上。
    expect(screen.getByText("1 项服务异常")).toBeInTheDocument();
  });

  it("通道没开时手动刷新退回一次 HTTP 请求", async () => {
    stubSocket();
    const fetchMock = vi
      .fn<(input: FetchInput) => Promise<Response>>(async () => json(history))
      .mockResolvedValueOnce(json(history))
      .mockResolvedValueOnce(json(payload))
      .mockResolvedValueOnce(json(history));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "刷新" }));

    expect(calledUrls(fetchMock).filter((url) => /\/api\/status$/.test(url))).toHaveLength(1);
  });

  it("通道开着时刷新只发一帧请求重推，不再走快照 HTTP", async () => {
    stubSocket();
    const fetchMock = vi.fn<(input: FetchInput) => Promise<Response>>(async () => json(history));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();
    connectAndPush();
    await screen.findByText("1 项服务异常");
    fetchMock.mockClear();

    await user.click(screen.getByRole("button", { name: "刷新" }));

    expect(FakeSocket.latest().sent).toContain("refresh");
    // 通道只推当前快照，日格仍要经 HTTP 补一次；快照接口因此不该被再打一遍。
    const urls = calledUrls(fetchMock);
    expect(urls.some((url) => /\/api\/status\/history$/.test(url))).toBe(true);
    expect(urls.some((url) => /\/api\/status$/.test(url))).toBe(false);
  });

  it("历史读不到时页面照常显示当前状态，条带说明没有样本", async () => {
    stubSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    renderPage();
    connectAndPush();

    expect(await screen.findByText("1 项服务异常")).toBeInTheDocument();
    for (const bar of screen.getAllByRole("img", { name: "这段时间还没有探测样本" })) {
      expect(bar).toBeInTheDocument();
    }
    // 历史读不到时窗口退回展示上限，可用率没有样本所以显示「—」。
    expect(screen.getByText("90 天全站可用率")).toBeInTheDocument();
  });
});
