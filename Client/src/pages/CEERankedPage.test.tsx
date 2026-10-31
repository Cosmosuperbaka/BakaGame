import { render, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { RANKED_IDLE_STATE, rankedProfile, rankedSeries } from "@/stories/fixtures/CEERanked";
import { useAccountStore } from "@/stores/UseAccountStore";
import { useCEEStore } from "@/stores/UseCEEStore";
import { useCEERankedStore } from "@/stores/UseCEERankedStore";
import CEERankedPage from "./CEERankedPage";

const initialAccount = useAccountStore.getState();
const initialCEE = useCEEStore.getState();
const initialRanked = useCEERankedStore.getState();

/** 模拟壳注入的桥接：页面只认它的存在，不在这里走签名。 */
const installShell = () => {
  window.__BAKA_CHANNEL__ = {
    clientType: "desktop",
    platform: "windows",
    clientVersion: "1.0.0",
    channelTicket: "",
    sign: vi.fn(),
    selfCheck: vi.fn(),
  } as never;
};

function renderPage() {
  return render(
    <HelmetProvider context={{}}>
      <MemoryRouter>
        <TooltipProvider>
          <CEERankedPage />
        </TooltipProvider>
      </MemoryRouter>
    </HelmetProvider>
  );
}

afterEach(() => {
  delete window.__BAKA_CHANNEL__;
  useAccountStore.setState(initialAccount, true);
  useCEEStore.setState(initialCEE, true);
  useCEERankedStore.setState(initialRanked, true);
});

describe("CEERankedPage", () => {
  it("网页端只给客户端下载说明，不自行推断准入", () => {
    useAccountStore.setState({ status: "signedIn", profile: {} as never });
    renderPage();

    expect(screen.getByRole("heading", { level: 1, name: /^排位赛/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "排位赛只在客户端开放" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /开始匹配/ })).not.toBeInTheDocument();
  });

  it("客户端未登录时引导登录", () => {
    installShell();
    useAccountStore.setState({ status: "guest", profile: null });
    renderPage();

    expect(screen.getByRole("heading", { name: "登录后参加排位赛" })).toBeInTheDocument();
  });

  it("账号状态还在读取时不渲染正文", () => {
    installShell();
    useAccountStore.setState({ status: "loading", profile: null });
    renderPage();

    expect(screen.queryByRole("heading", { name: /登录后参加排位赛|排位赛只在客户端开放/ })).toBe(
      null
    );
    expect(screen.queryByLabelText("正在连接排位")).not.toBeInTheDocument();
  });

  it("已登录但排位未就绪时给连接中占位", () => {
    installShell();
    useAccountStore.setState({ status: "signedIn", profile: {} as never });
    useCEERankedStore.setState({ ready: false, state: null, profile: null });
    renderPage();

    expect(screen.getByLabelText("正在连接排位")).toBeInTheDocument();
  });

  it("就绪后按状态给出排位首页", () => {
    installShell();
    useAccountStore.setState({ status: "signedIn", profile: {} as never });
    useCEERankedStore.setState({
      ready: true,
      state: RANKED_IDLE_STATE,
      profile: rankedProfile("rated"),
      loadProfile: vi.fn(async () => {}),
    });
    renderPage();

    expect(screen.getByRole("button", { name: "开始匹配" })).toBeInTheDocument();
    expect(screen.getByText("1532")).toBeInTheDocument();
  });

  it("系列赛进行中时换成顶栏比分与对局主体", () => {
    installShell();
    useAccountStore.setState({ status: "signedIn", profile: {} as never });
    useCEERankedStore.setState({
      ready: true,
      state: { status: "series", series: rankedSeries("playing") },
      profile: rankedProfile("rated"),
      loadProfile: vi.fn(async () => {}),
    });
    renderPage();

    expect(screen.getByLabelText("比分 0 比 1")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "你的猜测" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回主页" })).toBeDisabled();
  });
});
