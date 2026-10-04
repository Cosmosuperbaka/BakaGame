import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import LandingPage from "./LandingPage";
import { formatRelativeTime } from "@/lib/Time";

function renderLandingPage() {
  return render(
    <BrowserRouter>
      <TooltipProvider>
        <LandingPage />
      </TooltipProvider>
    </BrowserRouter>,
  );
}

describe("LandingPage", () => {
  it("renders all three friend links with correct URLs and target attributes", () => {
    renderLandingPage();

    const friendLinks = [
      { name: "二刺猿笑传之猜猜呗", href: "https://ccb.baka.website/" },
      { name: "动漫高手一眼顶针", href: "https://anipeek.animaster.dpdns.org/" },
      { name: "动漫高手截码战", href: "https://decrypto.monight.dpdns.org/" },
    ];

    for (const link of friendLinks) {
      const el = screen.getByRole("link", { name: new RegExp(link.name) });
      expect(el).toBeInTheDocument();
      expect(el).toHaveAttribute("href", link.href);
      expect(el).toHaveAttribute("target", "_blank");
      expect(el).toHaveAttribute("rel", "noreferrer");
    }
  });

  it("renders social links and game entries", () => {
    renderLandingPage();

    expect(screen.getByRole("link", { name: "加入 QQ 群" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "GitHub 仓库" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "作者哔哩哔哩主页" })).toBeInTheDocument();

    expect(screen.getByTestId("game-entry-whoisfaker")).toBeInTheDocument();
    expect(screen.getByTestId("game-entry-songuessr")).toBeInTheDocument();
    expect(screen.getByTestId("game-entry-animecharguessr")).toBeInTheDocument();
  });

  it("开放猜角色多人模式并保留排位与锦标赛未上线状态", () => {
    renderLandingPage();

    const ccbEntry = screen.getByTestId("game-entry-animecharguessr");
    const songEntry = screen.getByTestId("game-entry-songuessr");
    expect(ccbEntry).toBeInTheDocument();
    expect(ccbEntry.querySelector("[aria-disabled='true']")).toBeInTheDocument();
    expect(within(ccbEntry).getAllByText("即将上线")).toHaveLength(2);

    expect(within(ccbEntry).getByRole("button", { name: /多人模式/ })).toBeEnabled();
    expect(within(ccbEntry).getByText("多人模式")).toBeInTheDocument();
    expect(within(ccbEntry).getByText("排位赛")).toBeInTheDocument();
    expect(within(ccbEntry).getByText("锦标赛")).toBeInTheDocument();

    // Songuessr 两个子模式都已开放，不应再出现即将上线角标
    expect(within(songEntry).queryByText("即将上线")).not.toBeInTheDocument();

    // 可用游戏：Who is Faker 为正常入口 button；Songuessr 单人模式与多人模式均为交互 button
    expect(screen.getByRole("button", { name: /Who is Faker/ })).toBeInTheDocument();
    expect(within(songEntry).getByRole("button", { name: /多人模式/ })).toBeInTheDocument();
    expect(within(songEntry).getByRole("button", { name: /单人模式/ })).toBeInTheDocument();
  });

  it("生产部署禁用 CCB 增强版主页入口，只留「即将上线」占位", () => {
    vi.stubEnv("DEV", false);
    renderLandingPage();

    const ccbEntry = screen.getByTestId("game-entry-animecharguessr");
    // 卡片保留原尺寸与结构，但整卡不可用：没有任何可点击的入口，三个子模式都是占位格
    expect(ccbEntry.querySelector("[aria-disabled='true']")).toBeInTheDocument();
    expect(within(ccbEntry).getByText("即将上线")).toBeInTheDocument();
    expect(within(ccbEntry).queryByRole("button")).not.toBeInTheDocument();
    for (const mode of ["多人模式", "排位赛", "锦标赛"]) {
      expect(within(ccbEntry).getByText(mode)).toBeInTheDocument();
    }

    // 另外两个游戏的入口不受影响
    expect(screen.getByRole("button", { name: /Who is Faker/ })).toBeEnabled();
    expect(
      within(screen.getByTestId("game-entry-songuessr")).getByRole("button", { name: /多人模式/ }),
    ).toBeEnabled();
  });

  it("开发环境保留 CCB 增强版的多人模式入口", () => {
    vi.stubEnv("DEV", true);
    renderLandingPage();

    const ccbEntry = screen.getByTestId("game-entry-animecharguessr");
    expect(within(ccbEntry).getByRole("button", { name: /多人模式/ })).toBeEnabled();
  });

  it("renders categorized changelog in modal and omits absent categories", async () => {
    const user = userEvent.setup();
    renderLandingPage();

    const versionButton = screen.getByRole("button", { name: /^V\d+\.\d+\.\d+/ });
    await user.click(versionButton);

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // 检查存在对应更新的分类 Badge 与条目
    const featBadges = screen.getAllByText("feat");
    expect(featBadges.length).toBeGreaterThan(0);
    expect(screen.getByText("更新日志支持按变更类型分类展示")).toBeInTheDocument();
    expect(screen.getByText("Whoisfaker新增观战频道")).toBeInTheDocument();

    const fixBadges = screen.getAllByText("fix");
    expect(fixBadges.length).toBeGreaterThan(0);

    // 未填写的类型（如 docs、revert）在更新日志中不渲染
    expect(screen.queryByText("docs")).not.toBeInTheDocument();
    expect(screen.queryByText("revert")).not.toBeInTheDocument();
  });

  it("formats relative time correctly using Intl.RelativeTimeFormat", () => {
    const fixedNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);

    try {
      // 刚刚 (未来或0)
      expect(formatRelativeTime(new Date(fixedNow + 1000).toISOString())).toBe("刚刚");

      // 秒级
      expect(formatRelativeTime(new Date(fixedNow - 10 * 1000).toISOString())).toBe("10秒钟前");

      // 分钟级
      expect(formatRelativeTime(new Date(fixedNow - 5 * 60 * 1000).toISOString())).toBe("5分钟前");

      // 小时级
      expect(formatRelativeTime(new Date(fixedNow - 3 * 3600 * 1000).toISOString())).toBe("3小时前");

      // 天级
      expect(formatRelativeTime(new Date(fixedNow - 2 * 86400 * 1000).toISOString())).toBe("2天前");

      // 无效输入原样返回
      expect(formatRelativeTime("invalid-date")).toBe("invalid-date");
    } finally {
      nowSpy.mockRestore();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    ["Who is Faker 开始游戏", "/whoisfaker", "卧底大厅"],
    ["Songuessr 多人模式", "/songuessr", "猜歌大厅"],
  ])("入口 %s 导航至对应大厅", async (button, path, destination) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<TooltipProvider><LandingPage /></TooltipProvider>} />
          <Route path={path} element={<h1>{destination}</h1>} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: button }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.getByRole("heading", { name: destination })).toBeInTheDocument();
  });
});
