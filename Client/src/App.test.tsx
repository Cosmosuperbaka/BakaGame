import type { ReactNode } from "react";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/contexts/WhoIsFakerContext", () => ({
  WhoIsFakerProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/contexts/SonGuessrContext", () => ({
  SonGuessrProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/Toast", () => ({
  ToastContainer: () => null,
  SonGuessrToastContainer: () => null,
  ToastViewport: () => null,
}));
vi.mock("@/components/VersionUpdateNotice", () => ({
  VersionUpdateNotice: () => null,
}));
// 路由回归隔离页面与游戏布局；否则首次懒加载布局会额外冷转换 Store/WS 依赖图，
// 全套并行时可能仍在初始化，路由断言就已耗尽等待窗口。布局内的业务由专项测试覆盖。
vi.mock("@/layouts/WhoIsFakerLayout", async () => ({
  default: (await import("react-router-dom")).Outlet,
}));
vi.mock("@/layouts/SonGuessrLayout", async () => ({
  default: (await import("react-router-dom")).Outlet,
}));
vi.mock("@/pages/LandingPage", () => ({ default: () => <h1>landing-page</h1> }));
vi.mock("@/pages/WhoIsFakerPage", () => ({ default: () => <h1>faker-lobby</h1> }));
vi.mock("@/pages/WhoIsFakerRoomPage", () => ({ default: () => <h1>room-page</h1> }));
vi.mock("@/pages/SonGuessrPage", () => ({ default: () => <h1>song-lobby</h1> }));
vi.mock("@/pages/SonGuessrRoomPage", () => ({ default: () => <h1>song-room</h1> }));

import App from "./App";
import { createAppRouter } from "./AppRouter";

describe("application routing regressions", () => {
  let router: ReturnType<typeof createAppRouter> | undefined;

  const renderApp = () => {
    router = createAppRouter();
    return render(<App router={router} />);
  };

  afterEach(() => {
    cleanup();
    router?.dispose();
    router = undefined;
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("mounts the landing page on root path", async () => {
    window.history.replaceState({}, "", "/");
    renderApp();

    expect(await screen.findByText("landing-page")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });

  it.each(["/animecharguessr"])(
    "redirects removed route %s to the landing page",
    async (path) => {
      window.history.replaceState({}, "", path);
      renderApp();

      expect(await screen.findByText("landing-page")).toBeInTheDocument();
      await waitFor(() => expect(window.location.pathname).toBe("/"));
    },
  );

  it("redirects an invalid game sub-route to the game lobby", async () => {
    window.history.replaceState({}, "", "/whoisfaker/not-a-room");
    renderApp();

    expect(await screen.findByText("faker-lobby")).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/whoisfaker"));
  });

  it("keeps valid room routes mounted", async () => {
    window.history.replaceState({}, "", "/whoisfaker/room/AbCd");
    renderApp();

    expect(await screen.findByText("room-page")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/whoisfaker/room/AbCd");
  });

  it("mounts the Songuessr lobby", async () => {
    window.history.replaceState({}, "", "/songuessr");
    renderApp();

    expect(await screen.findByText("song-lobby")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/songuessr");
  });

  it("keeps valid Songuessr room routes mounted", async () => {
    window.history.replaceState({}, "", "/songuessr/room/1234");
    renderApp();

    expect(await screen.findByText("song-room")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/songuessr/room/1234");
  });

  it("redirects an invalid Songuessr sub-route to its lobby", async () => {
    window.history.replaceState({}, "", "/songuessr/not-a-room");
    renderApp();

    expect(await screen.findByText("song-lobby")).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/songuessr"));
  });

  it("handles dynamic chunk loading failure by triggering reload and suppressing error leak", async () => {
    const { retryLazyImport } = await import("@/lib/LazyImport");
    const reloadMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload: reloadMock });

    sessionStorage.clear();
    const failingLoader = vi.fn().mockRejectedValue(new TypeError("Failed to fetch dynamically imported module"));

    const pendingPromise = retryLazyImport(failingLoader, "test-chunk");
    await Promise.resolve();
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("bakagame:chunk-retry:test-chunk")).toBe("1");

    // 验证第二次失败时抛出错误
    await expect(retryLazyImport(failingLoader, "test-chunk")).rejects.toThrow("Failed to fetch");

    await expect(pendingPromise).rejects.toThrow("Failed to fetch");
  });
});
