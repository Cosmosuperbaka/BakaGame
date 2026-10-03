import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearStoredSongMusicSession,
  getStoredSongMusicSession,
  saveSongMusicSession,
} from "@/lib/SonGuessrMusicSession";
import type { SonGuessrRoomSnapshot } from "@/types";
import { useSonGuessrStore, type SonGuessrStore } from "@/stores/UseSonGuessrStore";
import { SongAccountSettings } from "./SongAccountSettings";

const snapshot = (musicAccountReady: boolean) => ({
  roomId: "1234",
  musicAccountReady,
} as SonGuessrRoomSnapshot);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const qrResponse = (key: string) => ({
  key,
  qrUrl: `https://example.invalid/login?codekey=${key}`,
  qrImage: `data:image/png;base64,${btoa(key)}`,
});
const authorizedResponse = {
  status: "authorized",
  message: "登录成功",
  cookie: "MUSIC_U=synthetic-test-fixture",
  account: { nickname: "夹具账号", vipStatus: "nonVip" as const },
};
const initialStore = useSonGuessrStore.getState();

describe("SongAccountSettings", () => {
  let sendCommand: ReturnType<typeof vi.fn>;
  let setNotice: ReturnType<typeof vi.fn<SonGuessrStore["setNotice"]>>;

  beforeEach(() => {
    clearStoredSongMusicSession();
    // framer-motion退出动画会请求恢复滚动位置，jsdom没有实现该浏览器API。
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    sendCommand = vi.fn().mockResolvedValue(qrResponse("initial-qr"));
    setNotice = vi.fn<SonGuessrStore["setNotice"]>();
    useSonGuessrStore.setState({
      sendCommand: sendCommand as unknown as SonGuessrStore["sendCommand"],
      setNotice,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    useSonGuessrStore.setState(initialStore, true);
  });

  it("展开未登录账号配置时自动生成二维码", async () => {
    sendCommand.mockResolvedValue({
      key: "qr-key",
      qrUrl: "https://music.163.com/login?codekey=qr-key",
      qrImage: "data:image/png;base64,dGVzdA==",
    });
    render(<SongAccountSettings snapshot={snapshot(false)} />);

    fireEvent.click(screen.getByRole("button", { name: /网易云账号/ }));

    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith("song.auth.qr.create");
    });
    expect(await screen.findByAltText("网易云登录二维码")).toBeInTheDocument();
  });

  it("登录后显示会员状态，并说明非会员也能出会员专享曲", () => {
    saveSongMusicSession({
      cookie: "MUSIC_U=browser-only",
      account: { nickname: "普通账号", vipStatus: "nonVip" },
    }, true);
    render(<SongAccountSettings snapshot={snapshot(true)} />);

    fireEvent.click(screen.getByRole("button", { name: /网易云账号/ }));

    expect(screen.getByText("非会员")).toBeInTheDocument();
    expect(screen.getByText("非会员账号也能出题，会员专享歌曲会自动匹配可用音源。")).toBeInTheDocument();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  // 「记住登录状态」默认值此前没有任何断言保护：改默认值不会打断现有用例，
  // 也就没人会发现默认值被悄悄改掉。这里钉住当前行为（默认 true = 持久化）。
  it("未存过登录状态时，记住登录开关默认为开启", () => {
    clearStoredSongMusicSession();
    expect(getStoredSongMusicSession()).toBeNull();

    render(<SongAccountSettings snapshot={snapshot(false)} />);
    fireEvent.click(screen.getByRole("button", { name: /网易云账号/ }));

    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it.each(["success", "failure"])("关闭重开后忽略旧二维码创建的迟到%s，不清除新请求加载态", async (outcome) => {
    const oldCreate = deferred<ReturnType<typeof qrResponse>>();
    const freshCreate = deferred<ReturnType<typeof qrResponse>>();
    sendCommand.mockReturnValueOnce(oldCreate.promise).mockReturnValueOnce(freshCreate.promise);
    render(<SongAccountSettings snapshot={snapshot(false)} />);
    const toggle = screen.getByRole("button", { name: /网易云账号/ });

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(sendCommand.mock.calls).toEqual([["song.auth.qr.create"], ["song.auth.qr.create"]]);

    await act(async () => {
      if (outcome === "success") oldCreate.resolve(qrResponse("old-qr"));
      else oldCreate.reject(new Error("旧二维码请求失败"));
    });
    expect(screen.queryByAltText("网易云登录二维码")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新二维码" })).toBeDisabled();
    expect(screen.queryByText("旧二维码请求失败")).not.toBeInTheDocument();
    expect(setNotice).not.toHaveBeenCalled();

    await act(async () => { freshCreate.resolve(qrResponse("fresh-qr")); });
    expect(screen.getByAltText("网易云登录二维码")).toHaveAttribute("src", qrResponse("fresh-qr").qrImage);
    expect(screen.getByRole("button", { name: "刷新二维码" })).toBeEnabled();
  });

  it("刷新二维码后旧轮询授权不落盘，新二维码仍能独立登录", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const oldCheck = deferred<typeof authorizedResponse>();
    const freshCreate = deferred<ReturnType<typeof qrResponse>>();
    sendCommand
      .mockResolvedValueOnce(qrResponse("old-qr"))
      .mockReturnValueOnce(oldCheck.promise)
      .mockReturnValueOnce(freshCreate.promise)
      .mockResolvedValueOnce(authorizedResponse);
    render(<SongAccountSettings snapshot={snapshot(false)} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /网易云账号/ })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(sendCommand).toHaveBeenLastCalledWith("song.auth.qr.check", { key: "old-qr" });

    fireEvent.click(screen.getByRole("button", { name: "刷新二维码" }));
    await act(async () => { oldCheck.resolve(authorizedResponse); });
    expect(getStoredSongMusicSession()).toBeNull();
    expect(setNotice).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "刷新二维码" })).toBeDisabled();

    await act(async () => { freshCreate.resolve(qrResponse("fresh-qr")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(sendCommand).toHaveBeenLastCalledWith("song.auth.qr.check", { key: "fresh-qr" });
    expect(getStoredSongMusicSession()).toEqual({
      cookie: authorizedResponse.cookie, account: authorizedResponse.account, persistent: true,
    });
    expect(screen.getByText("夹具账号")).toBeInTheDocument();
    expect(setNotice).toHaveBeenCalledExactlyOnceWith("网易云账号已加载到当前房间", "success");
  });

  it.each(["close", "room-change", "unmount", "return-to-account"])(
    "%s使在途二维码授权失效，不覆盖本机账号或发成功提示",
    async (boundary) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      if (boundary === "return-to-account") {
        saveSongMusicSession({ cookie: "MUSIC_U=existing-fixture", account: { nickname: "原账号", vipStatus: "vip" } }, true);
      }
      const previousSession = getStoredSongMusicSession();
      const pendingCheck = deferred<typeof authorizedResponse>();
      sendCommand.mockResolvedValueOnce(qrResponse("pending-qr")).mockReturnValueOnce(pendingCheck.promise);
      const view = render(<SongAccountSettings snapshot={snapshot(false)} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /网易云账号/ }));
      });
      if (boundary === "return-to-account") {
        fireEvent.click(screen.getByRole("button", { name: "更换账号" }));
        await act(async () => { fireEvent.click(screen.getByRole("button", { name: "刷新二维码" })); });
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      expect(sendCommand.mock.calls).toEqual([
        ["song.auth.qr.create"], ["song.auth.qr.check", { key: "pending-qr" }],
      ]);

      if (boundary === "close") fireEvent.click(screen.getByRole("button", { name: /网易云账号/ }));
      else if (boundary === "room-change") view.rerender(<SongAccountSettings snapshot={{ ...snapshot(false), roomId: "5678" }} />);
      else if (boundary === "unmount") view.unmount();
      else fireEvent.click(screen.getByRole("button", { name: "返回当前账号" }));

      await act(async () => { pendingCheck.resolve(authorizedResponse); });
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      expect(sendCommand).toHaveBeenCalledTimes(2);
      expect(getStoredSongMusicSession()).toEqual(previousSession);
      expect(setNotice).not.toHaveBeenCalled();
      expect(screen.queryByText("夹具账号")).not.toBeInTheDocument();
      if (boundary === "return-to-account") expect(screen.getByText("原账号")).toBeInTheDocument();
    },
  );

  it("在途二维码授权使用用户最新的保存开关，成功后停止轮询", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pendingCheck = deferred<typeof authorizedResponse>();
    sendCommand.mockResolvedValueOnce(qrResponse("login-qr")).mockReturnValueOnce(pendingCheck.promise);
    render(<SongAccountSettings snapshot={snapshot(false)} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /网易云账号/ })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    fireEvent.click(screen.getByRole("switch", { name: "保存登录状态" }));
    expect(screen.getByRole("switch", { name: "保存登录状态" })).toHaveAttribute("aria-checked", "false");

    await act(async () => { pendingCheck.resolve(authorizedResponse); });
    expect(getStoredSongMusicSession()).toEqual({
      cookie: authorizedResponse.cookie, account: authorizedResponse.account, persistent: false,
    });
    expect(screen.getByText("夹具账号")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(sendCommand.mock.calls).toEqual([
      ["song.auth.qr.create"], ["song.auth.qr.check", { key: "login-qr" }],
    ]);
  });

});
