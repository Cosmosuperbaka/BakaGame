import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import LandingPage from "./LandingPage";
import { formatRelativeTime } from "@/lib/Time";
import { useAccountStore } from "@/stores/UseAccountStore";

// 右上角的下载入口点开才问发布信息：这里给一份已发布的制品，供断言弹窗内容。
const WINDOWS_PACKAGE_URL = "https://cdn.test/files/BakaGame-latest-x64.exe";
const PACKAGES = [
  {
    platform: "windows",
    arch: "x64",
    url: WINDOWS_PACKAGE_URL,
    available: true,
    sizeBytes: 84_216_320,
    builtAt: "2026-10-19T09:12:33.000Z",
  },
];

function renderLandingPage() {
  return render(
    <BrowserRouter>
      <TooltipProvider>
        <LandingPage />
      </TooltipProvider>
    </BrowserRouter>
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

  it("反馈入口放在右上角账号右边，法务入口移入关于项目，页脚只留服务状态", () => {
    useAccountStore.setState({ status: "guest", profile: null });
    renderLandingPage();

    const account = screen.getByRole("button", { name: "账号" });
    const feedback = screen.getByRole("button", { name: /反馈/ });
    const row = account.parentElement as HTMLElement;
    expect(feedback.parentElement).toBe(row);
    expect(Array.from(row.children).indexOf(feedback)).toBeGreaterThan(
      Array.from(row.children).indexOf(account)
    );

    expect(screen.queryByRole("link", { name: "隐私说明" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "用户条款" })).not.toBeInTheDocument();

    const status = screen.getByRole("button", { name: "服务状态" });
    expect(status.querySelector("svg")).toBeInTheDocument();
    expect(status.className).not.toContain("underline");
  });

  it("下载客户端入口浮在右上角、排在账号左边，点了只谈系统与安装包", async () => {
    useAccountStore.setState({ status: "guest", profile: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ packages: PACKAGES }) }))
    );
    const user = userEvent.setup();
    renderLandingPage();

    const entry = screen.getByRole("button", { name: "下载客户端" });
    const account = screen.getByRole("button", { name: "账号" });
    // 同一排、下载在前：入口的位置本身就是「先看见再决定」，不该藏在页脚里。
    const row = entry.parentElement as HTMLElement;
    expect(row.contains(account)).toBe(true);
    expect(Array.from(row.children).indexOf(entry)).toBeLessThan(
      Array.from(row.children).indexOf(account)
    );

    await user.click(entry);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("安装包架构");
    expect(dialog).toHaveTextContent("构建日期");
    expect(dialog).toHaveTextContent("文件大小");
    expect(dialog).toHaveTextContent("80.3 MB");
    expect(screen.getByRole("link", { name: "下载 Windows 安装包" })).toHaveAttribute(
      "href",
      WINDOWS_PACKAGE_URL
    );
    vi.unstubAllGlobals();
  });

  it("入口文案不再拿反作弊说事：装不装由玩家在弹窗里自己判断", () => {
    renderLandingPage();

    expect(screen.getByRole("button", { name: "下载客户端" })).toBeInTheDocument();
    expect(screen.queryByText(/反作弊/)).not.toBeInTheDocument();
  });

  it("开放猜角色多人模式并保留排位与锦标赛未上线状态", () => {
    renderLandingPage();

    const ceeEntry = screen.getByTestId("game-entry-animecharguessr");
    const songEntry = screen.getByTestId("game-entry-songuessr");
    expect(ceeEntry).toBeInTheDocument();
    expect(ceeEntry.querySelector("[aria-disabled='true']")).toBeInTheDocument();
    expect(within(ceeEntry).getAllByText("即将上线")).toHaveLength(2);

    expect(within(ceeEntry).getByRole("button", { name: /多人模式/ })).toBeEnabled();
    expect(within(ceeEntry).getByText("多人模式")).toBeInTheDocument();
    expect(within(ceeEntry).getByText("排位赛")).toBeInTheDocument();
    expect(within(ceeEntry).getByText("锦标赛")).toBeInTheDocument();

    // Songuessr 两个子模式都已开放，不应再出现即将上线角标
    expect(within(songEntry).queryByText("即将上线")).not.toBeInTheDocument();

    // 可用游戏：Who is Faker 为正常入口 button；Songuessr 单人模式与多人模式均为交互 button
    expect(screen.getByRole("button", { name: /Who is Faker/ })).toBeInTheDocument();
    expect(within(songEntry).getByRole("button", { name: /多人模式/ })).toBeInTheDocument();
    expect(within(songEntry).getByRole("button", { name: /单人模式/ })).toBeInTheDocument();
  });

  it("版本号打开完整版本信息页并落在更新日志标签", async () => {
    const user = userEvent.setup();
    function CreditsProbe() {
      const location = useLocation();
      return <p>{`credits${location.pathname}${location.search}`}</p>;
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={
              <TooltipProvider>
                <LandingPage />
              </TooltipProvider>
            }
          />
          <Route path="/credits" element={<CreditsProbe />} />
        </Routes>
      </MemoryRouter>
    );

    await user.click(screen.getByRole("button", { name: /^V\d+\.\d+\.\d+/ }));

    expect(await screen.findByText("credits/credits?tab=changelog")).toBeInTheDocument();
    // 弹窗入口已经删除：版本详情只在完整页面上出现。
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
      expect(formatRelativeTime(new Date(fixedNow - 3 * 3600 * 1000).toISOString())).toBe(
        "3小时前"
      );

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
    vi.unstubAllGlobals();
  });

  it.each([
    ["Who is Faker 开始游戏", "/whoisfaker", "卧底大厅"],
    ["Songuessr 多人模式", "/songuessr", "猜歌大厅"],
  ])("入口 %s 导航至对应大厅", async (button, path, destination) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={
              <TooltipProvider>
                <LandingPage />
              </TooltipProvider>
            }
          />
          <Route path={path} element={<h1>{destination}</h1>} />
        </Routes>
      </MemoryRouter>
    );
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByRole("button", { name: button }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByRole("heading", { name: destination })).toBeInTheDocument();
  });
});
