import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPageControl } from "@/stores/UsePageControl";
import { PageControlHost } from "./PageControlHost";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  pathname: "/",
  handlers: [] as Array<
    (command: { id: string; action: "navigate" | "click"; path?: string; control?: string }) => void
  >,
  reportPageState: vi.fn(),
  reportPageResult: vi.fn(),
  clickByControl: vi.fn(),
  snapshotPageState: vi.fn(() => ({ path: "/", title: "", controls: [] })),
}));

// 只替换导航与位置：其余路由能力保持真实，组件仍按真实 hook 契约工作。
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    useLocation: () => ({ pathname: mocks.pathname }),
  };
});

vi.mock("@/lib/SiteWs", () => ({
  onPageCommand: (handler: (typeof mocks.handlers)[number]) => {
    mocks.handlers.push(handler);
    return () => {
      const index = mocks.handlers.indexOf(handler);
      if (index >= 0) mocks.handlers.splice(index, 1);
    };
  },
  reportPageResult: mocks.reportPageResult,
  reportPageState: mocks.reportPageState,
}));

vi.mock("@/lib/PageState", () => ({
  clickByControl: mocks.clickByControl,
  snapshotPageState: mocks.snapshotPageState,
}));

const dispatch = async (command: Parameters<(typeof mocks.handlers)[number]>[0]) => {
  await act(async () => {
    for (const handler of [...mocks.handlers]) handler(command);
  });
};

/** 推进假定时器并让 React 冲刷由此产生的 effect。 */
const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  mocks.navigate.mockReset();
  mocks.reportPageResult.mockReset();
  mocks.reportPageState.mockReset();
  mocks.clickByControl.mockReset();
  mocks.snapshotPageState.mockClear();
  mocks.handlers.length = 0;
  mocks.pathname = "/";
  setPageControl({ status: "off" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("页面接管执行端", () => {
  it("导航缺目标时回执失败，不调用路由", async () => {
    render(<PageControlHost />);
    await dispatch({ id: "c1", action: "navigate" });

    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.reportPageResult).toHaveBeenCalledWith({
      id: "c1",
      ok: false,
      error: "缺少导航目标",
    });
  });

  it("导航先回执「已接受」，150ms 后再补报落点", async () => {
    render(<PageControlHost />);
    await dispatch({ id: "c2", action: "navigate", path: "/songuessr" });

    expect(mocks.navigate).toHaveBeenCalledWith("/songuessr");
    expect(mocks.reportPageResult).toHaveBeenCalledWith({ id: "c2", ok: true });
    expect(mocks.reportPageState).not.toHaveBeenCalled();

    await advance(150);
    expect(mocks.snapshotPageState).toHaveBeenCalled();
    expect(mocks.reportPageState).toHaveBeenCalledTimes(1);
  });

  it("点击缺控件 id 时回执失败", async () => {
    render(<PageControlHost />);
    await dispatch({ id: "c3", action: "click" });

    expect(mocks.clickByControl).not.toHaveBeenCalled();
    expect(mocks.reportPageResult).toHaveBeenCalledWith({
      id: "c3",
      ok: false,
      error: "当前页面没有可点控件：",
    });
  });

  it("控件不在当前页面时回执失败", async () => {
    mocks.clickByControl.mockReturnValue(false);
    render(<PageControlHost />);
    await dispatch({ id: "c4", action: "click", control: "lobby.create" });

    expect(mocks.reportPageResult).toHaveBeenCalledWith({
      id: "c4",
      ok: false,
      error: "当前页面没有可点控件：lobby.create",
    });
  });

  it("点击成功后 400ms 补报一次状态", async () => {
    mocks.clickByControl.mockReturnValue(true);
    render(<PageControlHost />);
    await dispatch({ id: "c5", action: "click", control: "site.game.faker" });

    expect(mocks.clickByControl).toHaveBeenCalledWith("site.game.faker");
    expect(mocks.reportPageResult).toHaveBeenCalledWith({ id: "c5", ok: true });
    expect(mocks.reportPageState).not.toHaveBeenCalled();

    await advance(400);
    expect(mocks.reportPageState).toHaveBeenCalledTimes(1);
  });

  it("未开启接管时不上报状态，也不建立补报定时器", async () => {
    render(<PageControlHost />);

    await advance(6_000);
    expect(mocks.reportPageState).not.toHaveBeenCalled();
  });

  it("接管期间立即上报并按 2s 补齐控件，切换路径重建、卸载清理", async () => {
    render(<PageControlHost />);
    await act(async () => setPageControl({ status: "controlled", agentName: "agent" }));

    // 开启瞬间先报一次，之后每个 2s 周期再报。
    expect(mocks.reportPageState).toHaveBeenCalledTimes(1);
    await advance(2_000);
    expect(mocks.reportPageState).toHaveBeenCalledTimes(2);

    // 路径变化会重建定时器：立即补报一次，且旧定时器不再叠加。
    await act(async () => {
      mocks.pathname = "/songuessr";
      setPageControl({ status: "open" });
    });
    expect(mocks.reportPageState).toHaveBeenCalledTimes(3);
    await advance(2_000);
    expect(mocks.reportPageState).toHaveBeenCalledTimes(4);
  });

  it("卸载时解除命令订阅", () => {
    const { unmount } = render(<PageControlHost />);
    expect(mocks.handlers).toHaveLength(1);

    unmount();
    expect(mocks.handlers).toHaveLength(0);
  });
});
