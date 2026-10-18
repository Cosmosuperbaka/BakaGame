import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { BAKA_CLIENT_DOWNLOAD_URL } from "@/lib/AntiCheatCopy";
import LandingPage from "./LandingPage";
import { formatRelativeTime } from "@/lib/Time";

// 下载地址的唯一真实来源是 AntiCheatCopy，这里不改写它，只为「地址为空则整枚不渲染」留出开关。
const downloadUrl = vi.hoisted(() => ({ current: undefined as string | undefined }));

vi.mock("@/lib/AntiCheatCopy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/AntiCheatCopy")>();
  return {
    ...actual,
    get BAKA_CLIENT_DOWNLOAD_URL() {
      return downloadUrl.current ?? actual.BAKA_CLIENT_DOWNLOAD_URL;
    },
  };
});

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

  it("桌面客户端入口指向唯一下载地址并写明只有反作弊房需要", () => {
    renderLandingPage();

    const link = screen.getByRole("link", { name: /桌面客户端/ });
    expect(link).toHaveAttribute("href", BAKA_CLIENT_DOWNLOAD_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    // 措辞不能读成「要玩就得装」：入口文字自带限定条件。
    expect(link).toHaveTextContent("反作弊房需要");
  });

  it("制品尚未上传（地址为空）时不渲染桌面客户端入口", () => {
    downloadUrl.current = "";
    renderLandingPage();

    expect(screen.queryByRole("link", { name: /桌面客户端/ })).not.toBeInTheDocument();
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
    downloadUrl.current = undefined;
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
