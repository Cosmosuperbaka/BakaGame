import type { ReactNode } from "react";

import { cleanup, render, screen } from "@testing-library/react";
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
vi.mock("@/pages/StatusPage", () => ({
  default: () => {
    throw new Error("page-render-boom");
  },
}));
// 分块下载失败发生在浏览器的动态导入里，测试里让 admin 的加载器拒绝，其余逻辑走真实的自愈实现。
vi.mock("@/lib/LazyImport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/LazyImport")>();
  return {
    ...actual,
    retryLazyImport: <T,>(load: () => Promise<T>, key: string) =>
      actual.retryLazyImport(
        key === "admin"
          ? () => Promise.reject(new Error("Failed to fetch dynamically imported module: /a.js"))
          : load,
        key
      ),
  };
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
    expect(captureClientException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "page-render-boom" })
    );
  });

  it("分块加载失败时走自愈重载，仍显示站内回退界面且错误带自愈标记", async () => {
    renderAt("/admin");

    expect(await screen.findByRole("button", { name: "刷新页面" })).toBeInTheDocument();
    expect(reload).toHaveBeenCalledTimes(1);
    const reported = captureClientException.mock.calls[0]?.[0] as Error & {
      bakagameSelfHealedModuleLoad?: true;
    };
    expect(reported.bakagameSelfHealedModuleLoad).toBe(true);
  });
});
