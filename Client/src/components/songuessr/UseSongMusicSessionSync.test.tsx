import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SonGuessrStore } from "@/stores/UseSonGuessrStore";
import {
  clearStoredSongMusicSession,
  getStoredSongMusicSession,
  saveSongMusicSession,
} from "@/lib/SonGuessrMusicSession";
import { SONG_ACCOUNTS, songPrivate, songSnapshot } from "@/stories/fixtures/SonGuessr";
import { useSongMusicSessionSync } from "./UseSongMusicSessionSync";

type Input = Parameters<typeof useSongMusicSessionSync>[0];

const send = vi.fn();
const showToast = vi.fn();

const baseInput = (): Input => ({
  connected: true,
  snapshot: songSnapshot({ roomId: "1234", phase: "waiting" }),
  privateState: songPrivate({ playerId: "player-host" }),
  roomId: "1234",
  sendCommand: send as unknown as SonGuessrStore["sendCommand"],
  showToast,
});

const render = (input: Input) =>
  renderHook((props: Input) => useSongMusicSessionSync(props), { initialProps: input });

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const uploadCalls = () => send.mock.calls.filter(([type]) => type === "song.auth.useCookie");

beforeEach(() => {
  vi.useFakeTimers();
  send.mockReset();
  showToast.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  saveSongMusicSession({ cookie: "MUSIC_U=fixture", account: SONG_ACCOUNTS.vip }, true);
});

afterEach(() => {
  vi.useRealTimers();
  clearStoredSongMusicSession("all");
});

describe("useSongMusicSessionSync", () => {
  it("准备页自动把本机凭据装载进房间", async () => {
    send.mockResolvedValue({ account: SONG_ACCOUNTS.vip });
    render(baseInput());
    await flush();
    expect(uploadCalls()).toHaveLength(1);
    expect(uploadCalls()[0][1]).toEqual({ cookie: "MUSIC_U=fixture", platform: "netease" });
  });

  it("上游抖动按退避重试，落定后不再重复", async () => {
    let uploads = 0;
    send.mockImplementation(async (type: string) => {
      if (type !== "song.auth.useCookie") return undefined;
      uploads += 1;
      if (uploads === 1) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- 夹具抛出协议错误体：装载重试按 code 分支
        throw { code: "MUSIC_API_RATE_LIMITED", message: "上游限流" };
      }
      return { account: SONG_ACCOUNTS.vip };
    });
    render(baseInput());
    await flush();
    expect(uploads).toBe(1);
    await flush(1_000);
    expect(uploads).toBe(2);
    await flush(30_000);
    expect(uploads).toBe(2);
  });

  it("会话失效清除本机凭据并提示，不再重试", async () => {
    send.mockImplementation(async (type: string) => {
      if (type !== "song.auth.useCookie") return undefined;
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- 夹具抛出协议错误体：清凭据按 code 判别
      throw { code: "MUSIC_SESSION_INVALID", message: "登录状态已失效" };
    });
    render(baseInput());
    await flush();
    expect(uploadCalls()).toHaveLength(1);
    expect(getStoredSongMusicSession()).toBeNull();
    expect(showToast).toHaveBeenCalledWith("网易云登录状态已失效，请重新扫码登录", "error");
    await flush(30_000);
    expect(uploadCalls()).toHaveLength(1);
  });

  it("确定性拒绝不重试也不清本机凭据", async () => {
    send.mockImplementation(async (type: string) => {
      if (type !== "song.auth.useCookie") return undefined;
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- 夹具抛出协议错误体：确定性拒绝必须留在不重试分支
      throw { code: "MUSIC_AUTH_UNAVAILABLE", message: "认证服务不可用" };
    });
    render(baseInput());
    await flush();
    expect(uploadCalls()).toHaveLength(1);
    expect(getStoredSongMusicSession()).not.toBeNull();
    await flush(30_000);
    expect(uploadCalls()).toHaveLength(1);
  });

  it("局中不自动装载，回到准备页才装载", async () => {
    send.mockResolvedValue({ account: SONG_ACCOUNTS.vip });
    const input = baseInput();
    const { rerender } = render({
      ...input,
      snapshot: songSnapshot({ roomId: "1234", phase: "playing" }),
    });
    await flush();
    expect(uploadCalls()).toHaveLength(0);
    rerender(input);
    await flush();
    expect(uploadCalls()).toHaveLength(1);
  });

  it("池里已有本人这份凭据时不再重传", async () => {
    send.mockResolvedValue({ account: SONG_ACCOUNTS.vip });
    render({
      ...baseInput(),
      privateState: songPrivate({
        playerId: "player-host",
        musicAccounts: { netease: SONG_ACCOUNTS.vip },
      }),
    });
    await flush();
    expect(uploadCalls()).toHaveLength(0);
  });

  it("断线时不装载", async () => {
    send.mockResolvedValue({ account: SONG_ACCOUNTS.vip });
    render({ ...baseInput(), connected: false });
    await flush();
    expect(uploadCalls()).toHaveLength(0);
  });

  it("取消入口作废退避中的装载", async () => {
    let uploads = 0;
    send.mockImplementation(async (type: string) => {
      if (type !== "song.auth.useCookie") return undefined;
      uploads += 1;
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- 夹具抛出协议错误体：先触发一次退避再取消
      throw { code: "MUSIC_API_BUSY", message: "上游忙" };
    });
    const h = render(baseInput());
    await flush();
    expect(uploads).toBe(1);
    act(() => h.result.current.cancelMusicSessionUpload());
    await flush(10_000);
    expect(uploads).toBe(1);
  });

  it("退避等待中卸载后不再重传", async () => {
    let uploads = 0;
    send.mockImplementation(async (type: string) => {
      if (type !== "song.auth.useCookie") return undefined;
      uploads += 1;
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- 夹具抛出协议错误体：先排一次退避再卸载
      throw { code: "MUSIC_API_BUSY", message: "上游忙" };
    });
    const h = render(baseInput());
    await flush();
    expect(uploads).toBe(1);
    h.unmount();
    await flush(10_000);
    expect(uploads).toBe(1);
  });

  it("断线期间不装载，重连后重新发起装载", async () => {
    send.mockResolvedValue({ account: SONG_ACCOUNTS.vip });
    const input = baseInput();
    const { rerender } = render({ ...input, connected: false });
    await flush();
    expect(uploadCalls()).toHaveLength(0);
    rerender(input);
    await flush();
    expect(uploadCalls()).toHaveLength(1);
  });

  it("一个平台被判失效不影响另一个平台装载", async () => {
    saveSongMusicSession(
      { cookie: "QQ_COOKIE=test", account: { ...SONG_ACCOUNTS.vip, platform: "qq" } },
      true,
      "qq"
    );
    send.mockImplementation(async (type: string, payload: { platform: string }) => {
      if (type !== "song.auth.useCookie") return undefined;
      if (payload.platform === "netease") {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- 夹具抛出协议错误体：只让网易云被判失效
        throw { code: "MUSIC_SESSION_INVALID", message: "登录状态已失效" };
      }
      return { account: { ...SONG_ACCOUNTS.vip, platform: "qq" }, cookie: "QQ_COOKIE=refreshed" };
    });
    render(baseInput());
    await flush();
    expect(uploadCalls().map(([, payload]) => payload.platform)).toEqual(["netease", "qq"]);
    expect(getStoredSongMusicSession("netease")).toBeNull();
    expect(getStoredSongMusicSession("qq")?.cookie).toBe("QQ_COOKIE=refreshed");
    expect(showToast).toHaveBeenCalledWith("网易云登录状态已失效，请重新扫码登录", "error");
  });

  it("双平台凭据并行装载", async () => {
    saveSongMusicSession(
      { cookie: "QQ_COOKIE=test", account: { ...SONG_ACCOUNTS.vip, platform: "qq" } },
      true,
      "qq"
    );
    send.mockResolvedValue({ account: SONG_ACCOUNTS.vip });
    render(baseInput());
    await flush();
    const platforms = uploadCalls().map(([, payload]) => payload.platform);
    expect(platforms).toContain("netease");
    expect(platforms).toContain("qq");
  });

  it("落定后把本次实际生效的 cookie 写回本机凭据", async () => {
    send.mockResolvedValue({ account: SONG_ACCOUNTS.vip, cookie: "MUSIC_U=refreshed" });
    render(baseInput());
    await flush();
    expect(getStoredSongMusicSession()?.cookie).toBe("MUSIC_U=refreshed");
  });
});
