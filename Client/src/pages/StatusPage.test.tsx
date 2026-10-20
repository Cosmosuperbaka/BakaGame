import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import StatusPage from "./StatusPage";

const payload = {
  observedAt: 1_760_000_000_000,
  level: "degraded",
  version: "V1.2.3（abcdef1）",
  components: [
    { id: "service", level: "operational" },
    { id: "search", level: "degraded" },
    { id: "dataset", level: "operational" },
    { id: "images", level: "operational" },
    { id: "external", level: "unknown" },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

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
  it("展示后端聚合结果，并按组件逐项标注等级", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(payload)));
    renderPage();

    expect(await screen.findByText("部分服务异常")).toBeInTheDocument();
    expect(within(rowOf("游戏服务")).getByText("正常")).toBeInTheDocument();
    expect(within(rowOf("搜索索引")).getByText("异常")).toBeInTheDocument();
    expect(within(rowOf("外部监测")).getByText("未知")).toBeInTheDocument();
    expect(screen.getByText("V1.2.3（abcdef1）")).toBeInTheDocument();
  });

  it("后端不可达时页面照常打开，所有组件降级为未知", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    renderPage();

    expect(await screen.findByText("暂时无法确认服务状态")).toBeInTheDocument();
    for (const label of ["游戏服务", "搜索索引", "番剧数据", "图片缓存", "外部监测"]) {
      expect(within(rowOf(label)).getByText("未知")).toBeInTheDocument();
    }
    expect(screen.getByText(/后端状态接口暂时不可达/)).toBeInTheDocument();
    expect(screen.getByText(/当前页面版本/)).toBeInTheDocument();
  });

  it("手动刷新会重新请求，且不会自动轮询", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(payload))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("部分服务异常");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "刷新" }));

    expect(await screen.findByText("暂时无法确认服务状态")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
