import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation } from "react-router";
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
      { name: "二刺猿笑传之猜猜呗", href: expect.stringMatching(/^https:\/\/ccb\./) },
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
    expect(entry).toHaveClass("font-ui", "font-medium");
    expect(status).toHaveClass("font-ui", "font-medium");
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

  it("入口胶囊左端带玩法图标：开始、单人、多人、排位各一种，进不去的换成状态图标", () => {
    renderLandingPage();

    const iconOf = (element: HTMLElement) =>
      [...(element.querySelector("svg")?.classList ?? [])].find(
        (name) => name.startsWith("lucide-") && name !== "lucide-icon"
      );
    const song = screen.getByTestId("game-entry-songuessr");
    const cee = screen.getByTestId("game-entry-animecharguessr");
    expect(iconOf(screen.getByRole("link", { name: "Who is Faker 开始游戏" }))).toBe("lucide-play");
    expect(iconOf(within(song).getByRole("link", { name: /单人模式/ }))).toBe("lucide-user-round");
    expect(iconOf(within(song).getByRole("link", { name: /多人模式/ }))).toBe("lucide-users-round");
    expect(iconOf(within(cee).getByRole("link", { name: /排位赛/ }))).toBe("lucide-medal");
    expect(iconOf(within(screen.getByTestId("game-entry-mystery-1")).getByRole("button"))).toBe(
      "lucide-play"
    );
    // 还没上线的锦标赛不画奖杯：色块换成虚线框里的时钟，和能进的入口一眼分开。
    const tournament = within(cee)
      .getByText("锦标赛", { selector: "span" })
      .closest("[aria-disabled]");
    expect(iconOf(tournament as HTMLElement)).toBe("lucide-clock");
  });

  it("六款游戏排在同一面海报墙里，神秘游戏的海报与正式游戏一样", () => {
    renderLandingPage();

    // 海报墙不放可见标题，标题只给读屏与地标导航用；网格以它为名。
    expect(screen.getByRole("heading", { level: 2, name: "全部游戏" })).toHaveClass("sr-only");
    const games = screen.getByRole("list", { name: "全部游戏" });
    const cards = within(games).getAllByRole("listitem");
    expect(cards.map((card) => card.dataset.testid)).toEqual([
      "game-entry-whoisfaker",
      "game-entry-songuessr",
      "game-entry-animecharguessr",
      "game-entry-mystery-1",
      "game-entry-mystery-2",
      "game-entry-mystery-3",
    ]);

    for (const [index, card] of cards.slice(3).entries()) {
      const title = `神秘游戏${index + 1}`;
      // 和正式游戏同一种海报：标题同级，入口是同样的「开始游戏」胶囊，没有「即将上线」之类的另眼标记。
      expect(within(card).getByRole("heading", { level: 3, name: title })).toBeInTheDocument();
      const start = within(card).getByRole("button", { name: `${title} 开始游戏` });
      expect(start).toBeEnabled();
      expect(start).not.toHaveAttribute("data-agent-control");
      expect(within(card).queryByText("即将上线")).not.toBeInTheDocument();
      // 不剧透：没有封面图，也没有能带人离开首页的链接。
      expect(card.querySelector("img")).toBeNull();
      expect(within(card).queryByRole("link")).not.toBeInTheDocument();
    }
  });

  it("点了神秘游戏马上打开设置，敬请期待的播报区仍对读屏可见", async () => {
    const user = userEvent.setup();
    renderLandingPage();

    await user.click(screen.getByRole("button", { name: "神秘游戏1 开始游戏" }));
    await user.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("dialog");

    // 模态框把背后的页面设为对读屏隐藏，但会留下带 aria-live 的节点及其祖先；播报区不在任何被隐藏的子树里。
    const live = screen.getByText("神秘游戏1敬请期待", { selector: "[aria-live]" });
    expect(live.closest('[aria-hidden="true"]')).toBeNull();
    // 只留播报区本身：海报与入口仍随页面一起被隐藏，不会出现在弹窗背后。
    expect(
      screen.getByTestId("game-entry-mystery-1").closest('[aria-hidden="true"]')
    ).not.toBeNull();
  });

  it("神秘游戏的开始游戏不导航，只在按钮上提示敬请期待，过一会儿换回来", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderLandingPage();

    const card = screen.getByTestId("game-entry-mystery-1");
    const start = within(card).getByRole("button", { name: "神秘游戏1 开始游戏" });
    await user.click(start);

    expect(window.location.pathname).toBe("/");
    expect(start).toHaveTextContent("敬请期待");
    // 名字固定在按钮上，提示另走礼貌播报，读屏不会把两段文字连读。
    expect(start).toHaveAccessibleName("神秘游戏1 开始游戏");
    expect(screen.getByText("神秘游戏1敬请期待", { selector: "[aria-live]" })).toBeInTheDocument();
    // 播报区整页一处，不放进按钮：模态框打开时它会把所在的按钮一起留在背后可读。
    expect(card.querySelector("[aria-live]")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.queryByText("神秘游戏1敬请期待", { selector: "[aria-live]" })).toBeNull();
    // 旧文案淡出要走完退场动画：等它离场，而不是同步断言。
    await waitFor(() => expect(start).not.toHaveTextContent("敬请期待"));
    expect(start).toHaveTextContent("开始游戏");
  });

  it("顶栏的账号与反馈在窄屏只留图标时仍有可访问名", () => {
    useAccountStore.setState({ status: "guest", profile: null, unreadFeedback: 0 });
    renderLandingPage();

    // 文字在窄屏收起，名称不能跟着丢：读屏与按名称查找都靠 aria-label。
    expect(screen.getByRole("button", { name: "账号" })).toHaveAttribute("aria-label", "账号");
    expect(screen.getByRole("button", { name: "反馈" })).toHaveAttribute("aria-label", "反馈");
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
          <Route path="/abouts/changelog" element={<CreditsProbe />} />
        </Routes>
      </MemoryRouter>
    );

    const version = screen.getByRole("link", { name: /^V\d+\.\d+\.\d+/ });
    expect(version).toHaveAttribute("href", "/abouts/changelog");
    await user.click(version);

    expect(await screen.findByText("credits/abouts/changelog")).toBeInTheDocument();
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

  // 首页只留站名与游戏名：标题下不再有站点说明，游戏卡片也不带简介。
  it("标题下没有站点说明，游戏卡片只有游戏名", () => {
    const { container } = renderLandingPage();
    expect(container.querySelector("header p")).toBeNull();
    for (const id of ["whoisfaker", "songuessr", "animecharguessr"])
      expect(screen.getByTestId(`game-entry-${id}`).querySelector("p")).toBeNull();
    expect(
      within(screen.getByTestId("game-entry-animecharguessr")).getByText("那个游戏")
    ).toBeInTheDocument();
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
