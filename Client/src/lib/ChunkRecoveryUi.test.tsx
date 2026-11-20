// 分块自愈重载期间的界面与上报：被取消的动态导入既不能落到错误出口闪出报错界面，也不能上报。
// 预加载助手只存在于构建产物里，这里按它的行为模拟：派发可取消的失败事件，被取消就让导入解析成 undefined。
import { lazy, Suspense } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "@/components/common/AppErrorBoundary";
import { AppErrorFallback, RouteErrorFallback } from "@/components/common/AppErrorFallback";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { lazyPage } from "@/config/GameClient";
import * as recovery from "@/lib/ChunkRecovery";

const captureClientException = vi.hoisted(() => vi.fn());
vi.mock("@/lib/Sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/Sentry")>()),
  captureClientException,
}));

const reload = vi.fn();

const failingImport = <T,>(): Promise<T> => {
  const event = new Event("vite:preloadError", { cancelable: true });
  window.dispatchEvent(event);
  if (event.defaultPrevented) return Promise.resolve(undefined as T);
  return Promise.reject(new Error("Failed to fetch dynamically imported module: /a.js"));
};

let uninstall: (() => void) | undefined;

beforeEach(() => {
  captureClientException.mockClear();
  reload.mockClear();
  window.sessionStorage.clear();
  recovery.resetChunkRecoveryForTest();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  uninstall?.();
  uninstall = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 再等一会儿，确认错误界面与上报确实没有姗姗来迟（React 处理懒加载失败要跨几个调度任务）。 */
const flush = async () => {
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
};

describe("分块自愈重载期间的界面与上报", () => {
  it("路由懒加载的页面分块被取消：停在加载占位，不闪错误界面、不上报", async () => {
    // 路由创建时就开始取懒加载分块：自愈要先装好。
    vi.stubGlobal("location", { ...window.location, reload });
    uninstall = recovery.installChunkLoadRecovery();
    const router = createMemoryRouter(
      [
        {
          path: "/",
          errorElement: <RouteErrorFallback />,
          hydrateFallbackElement: <PageLoadingFallback />,
          lazy: lazyPage(() => failingImport<{ default: () => null }>()),
        },
      ],
      { initialEntries: ["/"] }
    );

    render(<RouterProvider router={router} />);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await flush();

    expect(screen.getByRole("status", { name: "页面加载中" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新页面" })).toBeNull();
    expect(captureClientException).not.toHaveBeenCalled();
    // 懒加载本身挂起等重载，路由根本没收到错误（不是靠错误出口兜住的）。
    expect(router.state.errors).toBeNull();
    router.dispose();
  });

  it("组件级懒加载（取命名导出）被取消：停在 Suspense 占位，错误边界不触发", async () => {
    vi.stubGlobal("location", { ...window.location, reload });
    uninstall = recovery.installChunkLoadRecovery();
    const Editor = lazy(async () => ({
      default: (await recovery.loadChunk(() => failingImport<{ Editor: () => null }>())).Editor,
    }));

    render(
      <AppErrorBoundary fallback={<AppErrorFallback />}>
        <Suspense fallback={<span>编辑器加载中</span>}>
          <Editor />
        </Suspense>
      </AppErrorBoundary>
    );
    await flush();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText("编辑器加载中")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新页面" })).toBeNull();
    expect(captureClientException).not.toHaveBeenCalled();
  });

  it("重载进行中仍有连带错误落到错误出口：显示加载占位，不上报", async () => {
    vi.stubGlobal("location", { ...window.location, reload });
    uninstall = recovery.installChunkLoadRecovery();
    window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(recovery.isChunkRecoveryReloading()).toBe(true);
    const router = createMemoryRouter(
      [
        {
          path: "/",
          errorElement: <RouteErrorFallback />,
          Component: () => {
            throw new TypeError("Cannot read properties of undefined (reading 'default')");
          },
        },
      ],
      { initialEntries: ["/"] }
    );

    render(<RouterProvider router={router} />);
    await flush();

    expect(screen.getByRole("status", { name: "页面加载中" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新页面" })).toBeNull();
    expect(captureClientException).not.toHaveBeenCalled();
    router.dispose();
  });

  it("自愈已用过时分块失败照常落到错误出口并上报", async () => {
    window.sessionStorage.setItem("bakagame:chunk-retry", "1");
    vi.stubGlobal("location", { ...window.location, reload });
    uninstall = recovery.installChunkLoadRecovery();
    const router = createMemoryRouter(
      [
        {
          path: "/",
          errorElement: <RouteErrorFallback />,
          hydrateFallbackElement: <PageLoadingFallback />,
          lazy: lazyPage(() => failingImport<{ default: () => null }>()),
        },
      ],
      { initialEntries: ["/"] }
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("button", { name: "刷新页面" })).toBeInTheDocument();
    await waitFor(() => expect(captureClientException).toHaveBeenCalledTimes(1));
    expect(reload).not.toHaveBeenCalled();
    router.dispose();
  });
});
