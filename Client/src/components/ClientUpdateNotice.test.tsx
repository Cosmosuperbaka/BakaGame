import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const DISMISS_KEY = "bakagame:client-update-dismissed";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const WINDOWS_PACKAGE = {
  platform: "windows",
  arch: "x64",
  url: "https://cdn.test/files/BakaGame-latest-x64.exe",
  available: true,
  sizeBytes: 84_216_320,
};

const ANDROID_PACKAGE = {
  platform: "android",
  arch: "全架构通用",
  url: "https://cdn.test/files/BakaGame-latest-release.apk",
  available: true,
  sizeBytes: 7_168_400,
};

/** 只注入壳自报的那几个字段：提醒读的是版本，凭据一概不碰。 */
const shellAt = (clientVersion: string, clientType: "desktop" | "mobile" = "desktop") => {
  window.__BAKA_CHANNEL__ = {
    clientType,
    platform: clientType === "mobile" ? "android" : "windows",
    clientVersion,
  };
};

interface ServerOptions {
  /** null = 通道未启用（503）；undefined 时按「过旧」回。 */
  floor?: string | null;
  /** undefined = 发布信息读不到（503）；null 表示服务端说这个平台还没发包。 */
  packages?: unknown;
}

/**
 * 一条桩服务同时接门槛与发布信息两个口，并把每次请求的 URL 记下来：
 * 「查了几次门槛」与「顺带问了几次发布信息」是两件事，混在一起数只会把断言写脆。
 */
const server = (options: ServerOptions = {}) => {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    if (url.includes("/api/client/packages")) {
      return options.packages === undefined
        ? json({ error: "unavailable" }, 503)
        : json({ packages: options.packages === null ? [] : options.packages });
    }
    if (options.floor === null) return json({ error: "CLIENT_CHANNEL_DISABLED" }, 503);
    return json({ outdated: true, minimumVersion: options.floor ?? "2.0.0" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, urls, checks: () => urls.filter((url) => url.includes("update-check")) };
};

afterEach(() => {
  delete window.__BAKA_CHANNEL__;
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/**
 * 每个用例都重新装一遍模块：`ClientPackages` 把成功结果缓存在模块级，
 * 不复位的话后一个用例拿到的是前一个用例的制品列表。
 */
const mountNotice = async () => {
  vi.resetModules();
  const { ClientUpdateNotice } = await import("./ClientUpdateNotice");
  return render(<ClientUpdateNotice />);
};

describe("客户端更新提醒", () => {
  it("版本低于门槛时提醒，并写明只影响反作弊房", async () => {
    shellAt("1.0.0");
    server({ floor: "2.0.0", packages: [WINDOWS_PACKAGE, ANDROID_PACKAGE] });
    await mountNotice();

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("桌面端版本较旧");
    expect(notice).toHaveTextContent("更新到 2.0.0 以上才能进反作弊房");
    expect(notice).toHaveTextContent("普通房间不受影响");
    // 下载链接要等发布信息问完才出现，不能拿刚渲染的那一帧去断言。
    expect(await screen.findByRole("link", { name: "下载最新版" })).toHaveAttribute(
      "href",
      WINDOWS_PACKAGE.url
    );
  });

  it("安卓壳点的是 APK：下载链接跟着壳自报的类型走", async () => {
    shellAt("1.0.0", "mobile");
    const { urls } = server({ floor: "3.1.0", packages: [WINDOWS_PACKAGE, ANDROID_PACKAGE] });
    await mountNotice();

    await screen.findByRole("status");
    const search = new URLSearchParams(new URL(urls[0]!).search);
    expect(search.get("clientType")).toBe("mobile");
    expect(search.get("clientVersion")).toBe("1.0.0");
    expect(screen.getByRole("status")).toHaveTextContent("移动端");
    expect(await screen.findByRole("link", { name: "下载最新版" })).toHaveAttribute(
      "href",
      ANDROID_PACKAGE.url
    );
  });

  it("够新时不打扰：不渲染也不留占位", async () => {
    shellAt("2.0.0");
    const fetchMock = vi.fn(async () => json({ outdated: false, minimumVersion: "2.0.0" }));
    vi.stubGlobal("fetch", fetchMock);
    await mountNotice();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("网页环境压根不查门槛：没有壳就没有客户端要更新", async () => {
    const { fetchMock } = server({ floor: "2.0.0" });
    await mountNotice();

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("门槛读不到时静默：接口未启用或断网都不该拦住首页", async () => {
    shellAt("1.0.0");
    const { fetchMock } = server({ floor: null });
    await mountNotice();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("关掉之后同一档门槛不再出现，抬档后重新提醒", async () => {
    shellAt("1.0.0");
    const first = server({ floor: "2.0.0", packages: [WINDOWS_PACKAGE] });
    vi.resetModules();
    const { ClientUpdateNotice: Notice } = await import("./ClientUpdateNotice");

    const { unmount } = render(<Notice />);
    await screen.findByRole("status");
    await userEvent.click(screen.getByRole("button", { name: "暂不提醒" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(window.localStorage.getItem(DISMISS_KEY)).toBe("2.0.0");

    // 同一个门槛：这一台设备已经说过不要提醒了。
    unmount();
    render(<Notice />);
    await waitFor(() => expect(first.checks()).toHaveLength(2));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // 服务端抬档：玩家上次关的是 2.0.0，新的门槛要重新说一次。
    unmount();
    const raised = server({ floor: "2.1.0", packages: [WINDOWS_PACKAGE] });
    render(<Notice />);
    expect(await screen.findByRole("status")).toHaveTextContent("2.1.0");
    expect(raised.checks()).toHaveLength(1);
  });

  it("制品还没推上去时不渲染下载按钮：宁可不给，也不给一个跳 404 的链接", async () => {
    shellAt("1.0.0");
    const { urls } = server({
      floor: "2.0.0",
      packages: [{ ...WINDOWS_PACKAGE, available: false, sizeBytes: undefined }],
    });
    await mountNotice();

    expect(await screen.findByRole("status")).toHaveTextContent("普通房间不受影响");
    // 等到发布信息真的问过并落进组件，再断言「没有链接」：早一拍看是白看不成。
    await waitFor(() => expect(urls.some((url) => url.includes("packages"))).toBe(true));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("发布信息读不到时同样不给按钮：猜一个链接等于赌玩家拿到什么", async () => {
    shellAt("1.0.0");
    const { urls } = server({ floor: "2.0.0" });
    await mountNotice();

    expect(await screen.findByRole("status")).toHaveTextContent("桌面端版本较旧");
    await waitFor(() => expect(urls.some((url) => url.includes("packages"))).toBe(true));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("展示层只由 props 驱动：关闭动作交给调用方", async () => {
    vi.resetModules();
    const { ClientUpdateBanner } = await import("./ClientUpdateNotice");
    const onDismiss = vi.fn();
    render(
      <ClientUpdateBanner
        open
        floor={{ clientType: "desktop", minimumVersion: "1.2.0" }}
        downloadUrl={WINDOWS_PACKAGE.url}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("更新到 1.2.0 以上");
    await userEvent.click(screen.getByRole("button", { name: "暂不提醒" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("open 为假或还没读到门槛时不占位", async () => {
    vi.resetModules();
    const { ClientUpdateBanner } = await import("./ClientUpdateNotice");
    render(
      <ClientUpdateBanner
        open={false}
        floor={{ clientType: "desktop", minimumVersion: "1.2.0" }}
        onDismiss={vi.fn()}
      />
    );
    render(<ClientUpdateBanner open floor={null} onDismiss={vi.fn()} />);
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });
});
