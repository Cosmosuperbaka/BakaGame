import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BAKA_CLIENT_DOWNLOAD_URL } from "@/lib/AntiCheatCopy";
import { ClientUpdateBanner, ClientUpdateNotice } from "./ClientUpdateNotice";

// 下载地址的唯一真实来源是 AntiCheatCopy，这里不改写它，只为「制品未上传」留出空地址开关。
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

const DISMISS_KEY = "bakagame:client-update-dismissed";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** 只注入壳自报的那几个字段：提醒读的是版本，凭据一概不碰。 */
const shellAt = (clientVersion: string, clientType: "desktop" | "mobile" = "desktop") => {
  window.__BAKA_CHANNEL__ = {
    clientType,
    platform: clientType === "mobile" ? "android" : "windows",
    clientVersion,
  };
};

const fetchOutdated = (minimumVersion: string | null) =>
  vi.fn(async () =>
    minimumVersion === null
      ? json({ error: "CLIENT_CHANNEL_DISABLED" }, 503)
      : json({ outdated: true, minimumVersion })
  );

afterEach(() => {
  delete window.__BAKA_CHANNEL__;
  vi.unstubAllGlobals();
  window.localStorage.clear();
  downloadUrl.current = undefined;
});

describe("客户端更新提醒", () => {
  it("版本低于门槛时提醒，并写明只影响反作弊房", async () => {
    shellAt("1.0.0");
    vi.stubGlobal("fetch", fetchOutdated("2.0.0"));
    render(<ClientUpdateNotice />);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("桌面端版本较旧");
    expect(notice).toHaveTextContent("更新到 2.0.0 以上才能进反作弊房");
    expect(notice).toHaveTextContent("普通房间不受影响");
    expect(screen.getByRole("link", { name: "下载最新版" })).toHaveAttribute(
      "href",
      BAKA_CLIENT_DOWNLOAD_URL
    );
  });

  it("问的是壳自己那一款的门槛：桌面与移动各算一档", async () => {
    shellAt("1.0.0", "mobile");
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      requested.push(input instanceof Request ? input.url : input.toString());
      return json({ outdated: true, minimumVersion: "3.1.0" });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ClientUpdateNotice />);

    await screen.findByRole("status");
    const search = new URLSearchParams(new URL(requested[0]).search);
    expect(search.get("clientType")).toBe("mobile");
    expect(search.get("clientVersion")).toBe("1.0.0");
    expect(screen.getByRole("status")).toHaveTextContent("移动端");
  });

  it("够新时不打扰：不渲染也不留占位", async () => {
    shellAt("2.0.0");
    const fetchMock = vi.fn(async () => json({ outdated: false, minimumVersion: "2.0.0" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ClientUpdateNotice />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("网页环境压根不查门槛：没有壳就没有客户端要更新", async () => {
    const fetchMock = fetchOutdated("2.0.0");
    vi.stubGlobal("fetch", fetchMock);
    render(<ClientUpdateNotice />);

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("门槛读不到时静默：接口未启用或断网都不该拦住首页", async () => {
    shellAt("1.0.0");
    const fetchMock = fetchOutdated(null);
    vi.stubGlobal("fetch", fetchMock);
    render(<ClientUpdateNotice />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("关掉之后同一档门槛不再出现，抬档后重新提醒", async () => {
    shellAt("1.0.0");
    const fetchMock = fetchOutdated("2.0.0");
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<ClientUpdateNotice />);
    await screen.findByRole("status");
    await userEvent.click(screen.getByRole("button", { name: "暂不提醒" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(window.localStorage.getItem(DISMISS_KEY)).toBe("2.0.0");

    // 同一个门槛：这一台设备已经说过不要提醒了。
    unmount();
    render(<ClientUpdateNotice />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // 服务端抬档：玩家上次关的是 2.0.0，新的门槛要重新说一次。
    unmount();
    vi.stubGlobal("fetch", fetchOutdated("2.1.0"));
    render(<ClientUpdateNotice />);
    expect(await screen.findByRole("status")).toHaveTextContent("2.1.0");
  });

  it("制品尚未上传（地址为空）时不渲染下载按钮", async () => {
    downloadUrl.current = "";
    shellAt("1.0.0");
    vi.stubGlobal("fetch", fetchOutdated("2.0.0"));
    render(<ClientUpdateNotice />);

    expect(await screen.findByRole("status")).toHaveTextContent("普通房间不受影响");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("展示层只由 props 驱动：关闭动作交给调用方", async () => {
    const onDismiss = vi.fn();
    render(
      <ClientUpdateBanner
        open
        floor={{ clientType: "desktop", minimumVersion: "1.2.0" }}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("更新到 1.2.0 以上");
    await userEvent.click(screen.getByRole("button", { name: "暂不提醒" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("open 为假或还没读到门槛时不占位", () => {
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
