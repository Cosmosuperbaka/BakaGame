import type { ReactNode } from "react";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureClientException = vi.hoisted(() => vi.fn());
vi.mock("@/lib/Sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Sentry")>()),
  captureClientException,
}));
vi.mock("framer-motion", () => ({
  MotionConfig: ({ children }: { children: ReactNode }) => children,
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <div {...props}>{children}</div>
    ),
    span: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
      <span {...props}>{children}</span>
    ),
  },
}));
vi.mock("@/components/ui/Tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/VersionUpdateNotice", () => ({ VersionUpdateNotice: () => null }));
vi.mock("@/layouts/RootLayout", async () => ({
  RootLayout: (await import("react-router-dom")).Outlet,
}));
vi.mock("@/pages/LandingPage", () => ({ default: () => <h1>landing-page</h1> }));
vi.mock("@/pages/NotFoundPage", () => ({ default: () => <h1>not-found-page</h1> }));
vi.mock("@/layouts/SonGuessrLayout", async () => ({
  default: (await import("react-router-dom")).Outlet,
}));
vi.mock("@/pages/SonGuessrRoomPage", () => ({
  default: ({ solo }: { solo?: boolean }) => <h1>{solo ? "song-solo-room" : "song-room"}</h1>,
}));
vi.mock("@/pages/StatusPage", () => ({
  default: () => {
    throw new Error("page-render-boom");
  },
}));
// 分块下载失败发生在浏览器的动态导入里：让 admin 页面模块加载即抛错来模拟（自愈重载由预加载失败事件
// 触发，见 ChunkRecovery 的用例；这里只看自愈之后仍然失败时的路由出口）。
vi.mock("@/pages/AdminPage", () => {
  throw new Error("Failed to fetch dynamically imported module: /a.js");
});

import App from "./App";
import { createAppRouter } from "./AppRouter";

describe("路由错误出口", () => {
  let router: ReturnType<typeof createAppRouter> | undefined;
  const reload = vi.fn();

  beforeEach(() => {
    captureClientException.mockClear();
    reload.mockClear();
    window.sessionStorage.clear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    router?.dispose();
    router = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const renderAt = (path: string) => {
    window.history.replaceState({}, "", path);
    router = createAppRouter();
    // 路由已按当前地址建好，再换掉 location 以便观察重载；jsdom 的 reload 不可直接监视。
    vi.stubGlobal("location", { ...window.location, reload });
    return render(<App router={router} />);
  };

  it("页面渲染抛错时上报并显示站内回退界面，而不是路由库默认报错页", async () => {
    renderAt("/status");

    expect(await screen.findByRole("button", { name: "刷新页面" })).toBeInTheDocument();
    expect(screen.queryByText(/Unexpected Application Error/i)).toBeNull();
    // 上报在回退界面挂载后的副作用里，按钮出现时未必已经执行。
    await waitFor(() =>
      expect(captureClientException).toHaveBeenCalledWith(
        expect.objectContaining({ message: "page-render-boom" })
      )
    );
  });

  it("分块加载失败（自愈之后仍失败）时显示站内回退界面并如实上报", async () => {
    renderAt("/admin");

    expect(await screen.findByRole("button", { name: "刷新页面" })).toBeInTheDocument();
    // 模块工厂抛出的错误被测试框架包了一层，原始错误在 cause 里。
    await waitFor(() =>
      expect(captureClientException).toHaveBeenCalledWith(
        expect.objectContaining({
          cause: expect.objectContaining({
            message: expect.stringContaining("Failed to fetch dynamically"),
          }),
        })
      )
    );
    // 路由层本身不再触发重载：自愈只在预加载失败事件里做。
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    ["/songuessr/solo", "song-solo-room"],
    ["/songuessr/room/1234", "song-room"],
  ])("猜歌房间路由 %s 渲染对应的页面形态", async (path, text) => {
    renderAt(path);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  // 乱码地址静默跳回首页，等于告诉抓取器「这里有一张首页」（软 404）；要明说页面不存在，地址也留在原处。
  it("全局未知路径渲染页面不存在，不跳回首页", async () => {
    renderAt("/no-such-page");
    expect(await screen.findByText("not-found-page")).toBeInTheDocument();
    expect(screen.queryByText("landing-page")).toBeNull();
    expect(router?.state.location.pathname).toBe("/no-such-page");
  });
});
