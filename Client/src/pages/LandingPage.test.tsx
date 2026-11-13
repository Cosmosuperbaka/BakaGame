import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import LandingPage from "./LandingPage";
import { OPEN_SITE_FEATURES } from "@bakagame/shared/values";
import { resetSiteFeaturesForTest } from "@/lib/SiteConfig";
import { formatRelativeTime } from "@/lib/Time";
import { useAccountStore } from "@/stores/UseAccountStore";

// 页脚的下载入口点开才问发布信息：这里给一份已发布的制品，供断言弹窗内容。
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

  it("设置、账号与反馈放在右上角同一排，法务入口移入关于项目", () => {
    useAccountStore.setState({ status: "guest", profile: null });
    renderLandingPage();

    const account = screen.getByRole("button", { name: "账号" });
    const feedback = screen.getByRole("button", { name: /反馈/ });
    const settings = screen.getByRole("button", { name: "设置" });
    const row = account.parentElement as HTMLElement;
    expect(feedback.parentElement).toBe(row);
    expect(settings.parentElement).toBe(row);
    expect(Array.from(row.children).indexOf(feedback)).toBeGreaterThan(
      Array.from(row.children).indexOf(account)
    );

    expect(screen.queryByRole("link", { name: "隐私说明" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "用户条款" })).not.toBeInTheDocument();

    const status = screen.getByRole("link", { name: "服务状态" });
    expect(status.querySelector("svg")).toBeInTheDocument();
    expect(status.className).not.toContain("underline");
  });

  it.each([
    ["loading", true],
    ["unavailable", false],
  ] as const)("账号服务状态为 %s 时账号与反馈入口仍然可见", (status, accountDisabled) => {
    useAccountStore.setState({ status, profile: null, unreadFeedback: 0 });
    renderLandingPage();

    const account = screen.getByRole("button", { name: "账号" });
    expect(account).toBeVisible();
    if (accountDisabled) expect(account).toBeDisabled();
    else expect(account).toBeEnabled();
    expect(screen.getByRole("button", { name: /反馈/ })).toBeEnabled();
  });

  it("账号服务不可用时反馈仍能打开匿名提交，且没有我的反馈入口", async () => {
    useAccountStore.setState({ status: "unavailable", profile: null, unreadFeedback: 0 });
    const user = userEvent.setup();
    renderLandingPage();

    await user.click(screen.getByRole("button", { name: /反馈/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("建议与问题都会被认真看到");
    expect(within(dialog).queryByRole("tab", { name: /我的反馈/ })).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("标题")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("标题"), "游客反馈");
    await user.type(within(dialog).getByLabelText("详细说明"), "无需登录");
    expect(within(dialog).getByRole("button", { name: "匿名提交" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "登录并提交" })).toBeEnabled();
  });

  it("游客点登录并提交会转到登录弹窗", async () => {
    useAccountStore.setState({ status: "unavailable", profile: null, unreadFeedback: 0 });
    const user = userEvent.setup();
    renderLandingPage();

    await user.click(screen.getByRole("button", { name: /反馈/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("标题"), "需要回复");
    await user.type(within(dialog).getByLabelText("详细说明"), "登录后提交");
    await user.click(within(dialog).getByRole("button", { name: "登录并提交" }));

    const login = (await screen.findByRole("heading", { name: "登录" })).closest(
      "[role='dialog']"
    ) as HTMLElement;
    await user.click(within(login).getByRole("button", { name: "关闭" }));

    // 取消登录回到匿名表单，已填内容不丢。
    expect(await screen.findByLabelText("标题")).toHaveValue("需要回复");
  });

  it("下载客户端入口在页脚服务状态旁边，点了只谈系统与安装包", async () => {
    useAccountStore.setState({ status: "guest", profile: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ packages: PACKAGES }) }))
    );
    const user = userEvent.setup();
    renderLandingPage();

    const entry = screen.getByRole("button", { name: "下载客户端" });
    const status = screen.getByRole("link", { name: "服务状态" });
    const row = status.parentElement as HTMLElement;
    expect(entry.parentElement).toBe(row);
    expect(Array.from(row.children).indexOf(entry)).toBeLessThan(
      Array.from(row.children).indexOf(status)
    );
    // 两个入口同为页脚操作标签：字体族与字重跟 Button 原语一致，不各写一套。
    expect(entry).toHaveClass("font-serif", "font-medium");
    expect(status).toHaveClass("font-serif", "font-medium");
    // 下载入口不再占用右上角：那一排只留设置、账号与反馈。
    const topRow = screen.getByRole("button", { name: "账号" }).parentElement as HTMLElement;
    expect(topRow.contains(entry)).toBe(false);

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

  it("开放猜角色多人模式与排位赛，锦标赛保留未上线状态", () => {
    renderLandingPage();

    const ceeEntry = screen.getByTestId("game-entry-animecharguessr");
    const songEntry = screen.getByTestId("game-entry-songuessr");
    expect(ceeEntry).toBeInTheDocument();
    expect(ceeEntry.querySelector("[aria-disabled='true']")).toBeInTheDocument();
    expect(within(ceeEntry).getAllByText("即将上线")).toHaveLength(1);

    expect(within(ceeEntry).getByRole("link", { name: /多人模式/ })).toBeEnabled();
    expect(within(ceeEntry).getByRole("link", { name: /排位赛/ })).toBeEnabled();
    expect(within(ceeEntry).getByText("多人模式")).toBeInTheDocument();
    expect(within(ceeEntry).getByText("锦标赛")).toBeInTheDocument();

    // Songuessr 两个子模式都已开放，不应再出现即将上线角标
    expect(within(songEntry).queryByText("即将上线")).not.toBeInTheDocument();

    // 可用入口都是真链接：抓取器、中键与「在新标签页打开」都拿得到地址。
    expect(screen.getByRole("link", { name: /Who is Faker/ })).toHaveAttribute(
      "href",
      "/whoisfaker"
    );
    expect(within(ceeEntry).getByRole("link", { name: /多人模式/ })).toHaveAttribute(
      "href",
      "/cee"
    );
    expect(within(ceeEntry).getByRole("link", { name: /排位赛/ })).toHaveAttribute(
      "href",
      "/cee/ranked"
    );
    expect(within(songEntry).getByRole("link", { name: /单人模式/ })).toHaveAttribute(
      "href",
      "/songuessr/solo"
    );
    expect(within(songEntry).getByRole("link", { name: /多人模式/ })).toBeInTheDocument();
    expect(within(songEntry).getByRole("link", { name: /单人模式/ })).toBeInTheDocument();
  });

  it("排位入口被服务端关掉后置灰标注暂时关闭，同卡其它入口照常", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ ceeRankedEntry: false }) }))
    );
    renderLandingPage();

    const ceeEntry = screen.getByTestId("game-entry-animecharguessr");
    // 配置是挂载后异步回来的：状态要等这一轮，不能同步断言碰运气。
    await waitFor(() => expect(within(ceeEntry).getByText("暂时关闭")).toBeInTheDocument());

    // 入口仍在页面上，只是不再是按钮：看得出这个玩法存在，但点不进去。
    expect(within(ceeEntry).queryByRole("link", { name: /排位赛/ })).not.toBeInTheDocument();
    const rankedLabel = within(ceeEntry).getByText("排位赛");
    expect(rankedLabel.closest('[aria-disabled="true"]')).not.toBeNull();

    // 点它不该导航：关掉的是入口，不该留一个能误触的按钮。
    await user.click(rankedLabel);
    expect(window.location.pathname).toBe("/");

    // 同卡其它入口照常：多人模式可点，锦标赛仍是「即将上线」，两种不可用态不混用文案。
    expect(within(ceeEntry).getByRole("link", { name: /多人模式/ })).toBeEnabled();
    expect(within(ceeEntry).getByText("锦标赛")).toBeInTheDocument();
    expect(within(ceeEntry).getByText("即将上线")).toBeInTheDocument();
  });

  it("后台临时关掉谁是卧底和猜歌单人后，入口原位置灰，其余模式照常", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ...OPEN_SITE_FEATURES, fakerEntry: false, songSoloEntry: false }),
      }))
    );
    renderLandingPage();

    const fakerEntry = screen.getByTestId("game-entry-whoisfaker");
    await waitFor(() => expect(within(fakerEntry).getByText("暂时关闭")).toBeInTheDocument());
    // 单一入口的卡片不消失，「开始游戏」换成点不进去的占位格。
    expect(within(fakerEntry).queryByRole("link")).not.toBeInTheDocument();
    const startLabel = within(fakerEntry).getByText("开始游戏");
    expect(startLabel.closest('[aria-disabled="true"]')).not.toBeNull();
    await user.click(startLabel);
    expect(window.location.pathname).toBe("/");

    // 只关单人：同卡的多人入口照常可点。
    const songEntry = screen.getByTestId("game-entry-songuessr");
    expect(within(songEntry).getByText("暂时关闭")).toBeInTheDocument();
    expect(within(songEntry).queryByRole("link", { name: /单人模式/ })).not.toBeInTheDocument();
    expect(within(songEntry).getByRole("link", { name: /多人模式/ })).toBeEnabled();
    // 没关的游戏不受影响。
    const ceeEntry = screen.getByTestId("game-entry-animecharguessr");
    expect(within(ceeEntry).queryByText("暂时关闭")).not.toBeInTheDocument();
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
          <Route path="/abouts" element={<CreditsProbe />} />
        </Routes>
      </MemoryRouter>
    );

    const version = screen.getByRole("link", { name: /^V\d+\.\d+\.\d+/ });
    expect(version).toHaveAttribute("href", "/abouts?tab=changelog");
    await user.click(version);

    expect(await screen.findByText("credits/abouts?tab=changelog")).toBeInTheDocument();
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
    resetSiteFeaturesForTest();
    useAccountStore.setState({ status: "loading", profile: null, unreadFeedback: 0 });
  });

  // 挂载时就会问一次站点配置：给一份全开，用例不必为每次渲染都写桩。
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ ceeRankedEntry: true }) }))
    );
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
      .click(screen.getByRole("link", { name: button }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByRole("heading", { name: destination })).toBeInTheDocument();
  });

  it("服务状态是指向状态页的真链接", () => {
    renderLandingPage();
    expect(screen.getByRole("link", { name: "服务状态" })).toHaveAttribute("href", "/status");
  });

  // 首页标题之下一行说清站里有什么，每张卡片一行游戏简介：文字与分享卡片、外壳取自同一份 PageMeta。
  it("标题下有一行站点说明，每张游戏卡有一行简介", () => {
    renderLandingPage();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent === "谁是卧底、听歌猜歌、猜动漫角色。开一间房，把房号发进群。"
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("game-entry-whoisfaker")).getByText("出题人现场写词的谁是卧底")
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("game-entry-songuessr")).getByText("听歌识曲，也听歌识番")
    ).toBeInTheDocument();
    const cee = screen.getByTestId("game-entry-animecharguessr");
    expect(within(cee).getByText("CEE")).toBeInTheDocument();
    expect(within(cee).getByText("二刺猿笑传之猜猜呗增强版")).toBeInTheDocument();
  });

  it("中键或带修饰键点入口时交还浏览器，不在当前页导航", () => {
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
          <Route path="/cee" element={<h1>猜角色大厅</h1>} />
        </Routes>
      </MemoryRouter>
    );
    const link = within(screen.getByTestId("game-entry-animecharguessr")).getByRole("link", {
      name: /多人模式/,
    });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("heading", { name: "猜角色大厅" })).not.toBeInTheDocument();
  });
});
