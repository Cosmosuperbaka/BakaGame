import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { SITE_ORIGIN } from "@/data/PageMeta";

vi.mock("@/layouts/RootLayout", async () => ({
  RootLayout: (await import("react-router")).Outlet,
}));
vi.mock("@/pages/NotFoundPage", () => ({ default: () => <h1>not-found-page</h1> }));

import { createAppRouter } from "@/AppRouter";

/**
 * 关于页的标签与地址：走真实的路由装配，验证每个标签只有一个规范地址，
 * 有独立路径的三个标签各自带上自己的 canonical。
 */
describe("关于页的标签地址", () => {
  let router: ReturnType<typeof createAppRouter> | undefined;

  afterEach(() => {
    cleanup();
    router?.dispose();
    router = undefined;
  });

  const renderAt = (path: string) => {
    window.history.replaceState({}, "", path);
    router = createAppRouter();
    render(
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    );
  };
  // 页面分块首次加载要走一遍懒加载，比默认的等待上限慢，放宽到几秒。
  const findSelectedTab = (name: string) =>
    screen.findByRole("tab", { name, selected: true }, { timeout: 5000 });
  const address = () => `${router!.state.location.pathname}${router!.state.location.search}`;
  const canonical = () =>
    document.head.querySelector('link[rel="canonical"]')?.getAttribute("href");

  it.each([
    ["/abouts/changelog", "更新日志"],
    ["/abouts/privacy", "隐私说明"],
    ["/abouts/terms", "用户条款"],
  ])("%s 直接打开对应标签，canonical 指向这个独立地址", async (path, label) => {
    renderAt(path);
    expect(await findSelectedTab(label)).toBeInTheDocument();
    expect(address()).toBe(path);
    await waitFor(() => expect(canonical()).toBe(`${SITE_ORIGIN}${path}`));
  });

  it("关于页本身是开源致谢，canonical 指向关于页", async () => {
    renderAt("/abouts");
    expect(await findSelectedTab("开源致谢")).toBeInTheDocument();
    expect(address()).toBe("/abouts");
    await waitFor(() => expect(canonical()).toBe(`${SITE_ORIGIN}/abouts`));
  });

  it.each([
    ["/abouts?tab=changelog", "/abouts/changelog", "更新日志"],
    ["/abouts?tab=privacy", "/abouts/privacy", "隐私说明"],
    ["/abouts?tab=credits", "/abouts", "开源致谢"],
    ["/abouts?tab=nope", "/abouts", "开源致谢"],
  ])("%s 原地换成规范地址 %s", async (path, expected, label) => {
    renderAt(path);
    expect(await findSelectedTab(label)).toBeInTheDocument();
    expect(address()).toBe(expected);
  });

  it("提交历史仍挂在 ?tab= 上，canonical 收拢到关于页", async () => {
    renderAt("/abouts?tab=commits");
    expect(await findSelectedTab("提交历史")).toBeInTheDocument();
    expect(address()).toBe("/abouts?tab=commits");
    await waitFor(() => expect(canonical()).toBe(`${SITE_ORIGIN}/abouts`));
  });

  it("页内切标签换到该标签的规范地址，不往历史里堆记录", async () => {
    const user = userEvent.setup();
    renderAt("/abouts");
    await findSelectedTab("开源致谢");

    await user.click(screen.getByRole("tab", { name: "隐私说明" }));
    await waitFor(() => expect(address()).toBe("/abouts/privacy"));
    expect(screen.getByRole("tab", { name: "隐私说明", selected: true })).toBeInTheDocument();
    expect(router!.state.historyAction).toBe("REPLACE");

    await user.click(screen.getByRole("tab", { name: "提交历史" }));
    await waitFor(() => expect(address()).toBe("/abouts?tab=commits"));

    await user.click(screen.getByRole("tab", { name: "开源致谢" }));
    await waitFor(() => expect(address()).toBe("/abouts"));
  });

  it("关于页下未登记的路径明说页面不存在", async () => {
    renderAt("/abouts/commits");
    expect(await screen.findByText("not-found-page")).toBeInTheDocument();
  });
});
