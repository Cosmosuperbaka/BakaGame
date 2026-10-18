import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearStoredSongMusicSession,
  getStoredSongMusicSession,
  saveSongMusicSession,
} from "@/lib/SonGuessrMusicSession";
import type { SonGuessrRoomSnapshot } from "@/types";
import { useSonGuessrStore, type SonGuessrStore } from "@/stores/UseSonGuessrStore";
import { SongAccountSettings } from "./SongAccountSettings";

const snapshot = (musicAccountReady: boolean) =>
  ({
    roomId: "1234",
    musicAccountReady,
  }) as SonGuessrRoomSnapshot;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
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
/** 展开后的内容区：收起单行里也会写昵称与会员状态，断言只看正文。 */
const panel = () =>
  within(
    document.getElementById(
      screen.getByRole("button", { name: /音乐账号配置/ }).getAttribute("aria-controls")!
    )!
  );

describe("SongAccountSettings", () => {
  let sendCommand: ReturnType<typeof vi.fn<SonGuessrStore["sendCommand"]>>;
  let setNotice: ReturnType<typeof vi.fn<SonGuessrStore["setNotice"]>>;

  beforeEach(() => {
    clearStoredSongMusicSession();
    // framer-motion退出动画会请求恢复滚动位置，jsdom没有实现该浏览器API。
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    sendCommand = vi
      .fn<SonGuessrStore["sendCommand"]>()
      .mockResolvedValue(qrResponse("initial-qr"));
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

    fireEvent.click(screen.getByRole("button", { name: /音乐账号配置/ }));

    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith("song.auth.qr.create");
    });
    expect(await screen.findByAltText("网易云登录二维码")).toBeInTheDocument();
  });

  it("登录后显示会员状态，并说明非会员也能出会员专享曲", () => {
    saveSongMusicSession(
      {
        cookie: "MUSIC_U=browser-only",
        account: { nickname: "普通账号", vipStatus: "nonVip" },
      },
      true
    );
    render(<SongAccountSettings snapshot={snapshot(true)} />);

    fireEvent.click(screen.getByRole("button", { name: /音乐账号配置/ }));

    expect(panel().getByText("非会员")).toBeInTheDocument();
    expect(
      panel().getByText("非会员账号也能出题，会员专享歌曲会自动匹配可用音源。")
    ).toBeInTheDocument();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("未登录时收起态双平台均显示未配置", () => {
    render(<SongAccountSettings snapshot={snapshot(false)} />);
    const toggle = screen.getByRole("button", { name: /音乐账号配置/ });

    expect(within(toggle).getAllByText("未配置")).toHaveLength(2);
    expect(toggle.querySelector("svg")).toBeInTheDocument();
    expect(toggle.querySelector("img")).not.toBeInTheDocument();
  });

  it("加载到房间后才显示账号：收起态单行排头像、昵称、会员徽章图与到期日", () => {
    saveSongMusicSession(
      {
        cookie: "MUSIC_U=browser-only",
        account: {
          nickname: "黑胶账号",
          avatarUrl: "https://example.invalid/avatar.jpg",
          vipStatus: "vip",
          vipTier: "svip",
          vipLevel: 5,
          vipExpireTime: Date.UTC(2027, 2, 31, 16, 0, 0),
        },
      },
      true
    );
    const view = render(<SongAccountSettings snapshot={snapshot(false)} />);
    const toggle = screen.getByRole("button", { name: /音乐账号配置/ });
    // 本机有凭据但还没装进房间：只说正在连接，不出现账号，也不再有「已连接」这类状态标。
    expect(within(toggle).getByText("正在连接网易云账号…")).toBeInTheDocument();
    expect(within(toggle).getByText("未配置")).toBeInTheDocument();
    expect(screen.queryByText(/已连接|本机已登录/)).not.toBeInTheDocument();

    view.rerender(<SongAccountSettings snapshot={snapshot(true)} />);
    // 收起态就是单行：头像、昵称、官方会员徽章图与到期日都直接出现在按钮里，未配置的QQ音乐也清晰可见
    expect(
      toggle.querySelector("img[src='https://example.invalid/avatar.jpg']")
    ).toBeInTheDocument();
    expect(within(toggle).getByText("黑胶账号")).toBeInTheDocument();
    expect(within(toggle).getByRole("img", { name: "SVIP · 伍" })).toHaveAttribute(
      "src",
      "/assets/netease-vip/SVIP-5.png"
    );
    expect(within(toggle).getByText("2027/4/1 到期")).toBeInTheDocument();
    expect(within(toggle).getByText("未配置")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(panel().getByText("黑胶账号")).toBeInTheDocument();
    // 展开卡里是同一张官方徽章图，两处不漂移。
    expect(panel().getByRole("img", { name: "SVIP · 伍" })).toHaveAttribute(
      "src",
      "/assets/netease-vip/SVIP-5.png"
    );
    expect(panel().getByText("2027/4/1 到期")).toBeInTheDocument();
    expect(panel().queryByRole("button", { name: "更换账号" })).not.toBeInTheDocument();
  });

  // 标题行收起时是账号行，展开后要让位给普通的组标题：展开卡里已有同一份账号信息，
  // 标题行不再重复；读屏的描述也一并交还给正文，不再朗读已经撤走的账号行。
  it("展开后标题行换回普通标题，账号行不再重复", async () => {
    saveSongMusicSession(
      {
        cookie: "MUSIC_U=browser-only",
        account: {
          nickname: "黑胶账号",
          avatarUrl: "https://example.invalid/avatar.jpg",
          vipStatus: "vip",
          vipTier: "svip",
          vipLevel: 5,
          vipExpireTime: Date.UTC(2027, 2, 31, 16, 0, 0),
        },
      },
      true
    );
    render(<SongAccountSettings snapshot={snapshot(true)} />);
    const toggle = screen.getByRole("button", { name: /音乐账号配置/ });

    fireEvent.click(toggle);

    expect(toggle).toHaveAccessibleName("音乐账号配置");
    expect(toggle).toHaveAccessibleDescription("");
    await waitFor(() => {
      expect(within(toggle).queryByRole("img", { name: "SVIP · 伍" })).not.toBeInTheDocument();
      expect(within(toggle).queryByText("黑胶账号")).not.toBeInTheDocument();
    });
    expect(panel().getByText("黑胶账号")).toBeInTheDocument();
  });

  it("退出登录：清掉房间与本机凭据，面板直接换成新二维码", async () => {
    saveSongMusicSession(
      { cookie: "MUSIC_U=browser-only", account: { nickname: "旧账号", vipStatus: "vip" } },
      true
    );
    sendCommand.mockImplementation(async (type: string) =>
      type === "song.auth.qr.create" ? qrResponse("after-logout") : {}
    );
    render(<SongAccountSettings snapshot={snapshot(true)} />);

    fireEvent.click(screen.getByRole("button", { name: /音乐账号配置/ }));
    expect(sendCommand).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    });

    expect(sendCommand.mock.calls).toEqual([["song.auth.clear"], ["song.auth.qr.create"]]);
    expect(getStoredSongMusicSession()).toBeNull();
    expect(setNotice).toHaveBeenCalledWith("已退出网易云账号", "success");
    expect(await screen.findByAltText("网易云登录二维码")).toHaveAttribute(
      "src",
      qrResponse("after-logout").qrImage
    );
  });

  // 「记住登录状态」默认值此前没有任何断言保护：改默认值不会打断现有用例，
  // 也就没人会发现默认值被悄悄改掉。这里钉住当前行为（默认 true = 持久化）。
  it("未存过登录状态时，记住登录开关默认为开启", () => {
    clearStoredSongMusicSession();
    expect(getStoredSongMusicSession()).toBeNull();

    render(<SongAccountSettings snapshot={snapshot(false)} />);
    fireEvent.click(screen.getByRole("button", { name: /音乐账号配置/ }));

    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it.each(["success", "failure"])(
    "关闭重开后忽略旧二维码创建的迟到%s，不清除新请求加载态",
    async (outcome) => {
      const oldCreate = deferred<ReturnType<typeof qrResponse>>();
      const freshCreate = deferred<ReturnType<typeof qrResponse>>();
      sendCommand.mockReturnValueOnce(oldCreate.promise).mockReturnValueOnce(freshCreate.promise);
      render(<SongAccountSettings snapshot={snapshot(false)} />);
      const toggle = screen.getByRole("button", { name: /音乐账号配置/ });

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

      await act(async () => {
        freshCreate.resolve(qrResponse("fresh-qr"));
      });
      expect(screen.getByAltText("网易云登录二维码")).toHaveAttribute(
        "src",
        qrResponse("fresh-qr").qrImage
      );
      expect(screen.getByRole("button", { name: "刷新二维码" })).toBeEnabled();
    }
  );

  it("刷新二维码后旧轮询授权不落盘，新二维码仍能独立登录", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const oldCheck = deferred<typeof authorizedResponse>();
    const freshCreate = deferred<ReturnType<typeof qrResponse>>();
    sendCommand
      .mockResolvedValueOnce(qrResponse("old-qr"))
      .mockReturnValueOnce(oldCheck.promise)
      .mockReturnValueOnce(freshCreate.promise)
      .mockResolvedValueOnce(authorizedResponse);
    const view = render(<SongAccountSettings snapshot={snapshot(false)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /音乐账号配置/ }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(sendCommand).toHaveBeenLastCalledWith("song.auth.qr.check", { key: "old-qr" });

    fireEvent.click(screen.getByRole("button", { name: "刷新二维码" }));
    await act(async () => {
      oldCheck.resolve(authorizedResponse);
    });
    expect(getStoredSongMusicSession()).toBeNull();
    expect(setNotice).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "刷新二维码" })).toBeDisabled();

    await act(async () => {
      freshCreate.resolve(qrResponse("fresh-qr"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(sendCommand).toHaveBeenLastCalledWith("song.auth.qr.check", { key: "fresh-qr" });
    expect(getStoredSongMusicSession()).toEqual({
      cookie: authorizedResponse.cookie,
      account: authorizedResponse.account,
      persistent: true,
    });
    // 服务端装好会话后推送的快照里 musicAccountReady 为真，账号随之出现。
    view.rerender(<SongAccountSettings snapshot={snapshot(true)} />);
    expect(panel().getByText("夹具账号")).toBeInTheDocument();
    expect(setNotice).toHaveBeenCalledExactlyOnceWith("网易云账号已加载到当前房间", "success");
  });

  it.each(["close", "room-change", "unmount"])(
    "%s使在途二维码授权失效，不覆盖本机账号或发成功提示",
    async (boundary) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const previousSession = getStoredSongMusicSession();
      const pendingCheck = deferred<typeof authorizedResponse>();
      sendCommand
        .mockResolvedValueOnce(qrResponse("pending-qr"))
        .mockReturnValueOnce(pendingCheck.promise);
      const view = render(<SongAccountSettings snapshot={snapshot(false)} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /音乐账号配置/ }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(sendCommand.mock.calls).toEqual([
        ["song.auth.qr.create"],
        ["song.auth.qr.check", { key: "pending-qr" }],
      ]);

      if (boundary === "close")
        fireEvent.click(screen.getByRole("button", { name: /音乐账号配置/ }));
      else if (boundary === "room-change")
        view.rerender(<SongAccountSettings snapshot={{ ...snapshot(false), roomId: "5678" }} />);
      else view.unmount();

      await act(async () => {
        pendingCheck.resolve(authorizedResponse);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(sendCommand).toHaveBeenCalledTimes(2);
      expect(getStoredSongMusicSession()).toEqual(previousSession);
      expect(setNotice).not.toHaveBeenCalled();
      expect(screen.queryByText("夹具账号")).not.toBeInTheDocument();
    }
  );

  it("在途二维码授权使用用户最新的保存开关，成功后停止轮询", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pendingCheck = deferred<typeof authorizedResponse>();
    sendCommand
      .mockResolvedValueOnce(qrResponse("login-qr"))
      .mockReturnValueOnce(pendingCheck.promise);
    const view = render(<SongAccountSettings snapshot={snapshot(false)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /音乐账号配置/ }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    fireEvent.click(screen.getByRole("switch", { name: "保存登录状态" }));
    expect(screen.getByRole("switch", { name: "保存登录状态" })).toHaveAttribute(
      "aria-checked",
      "false"
    );

    await act(async () => {
      pendingCheck.resolve(authorizedResponse);
    });
    expect(getStoredSongMusicSession()).toEqual({
      cookie: authorizedResponse.cookie,
      account: authorizedResponse.account,
      persistent: false,
    });
    view.rerender(<SongAccountSettings snapshot={snapshot(true)} />);
    expect(panel().getByText("夹具账号")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(sendCommand.mock.calls).toEqual([
      ["song.auth.qr.create"],
      ["song.auth.qr.check", { key: "login-qr" }],
    ]);
  });

  it("切换至 QQ 音乐标签页支持三种扫码方式切换并请求对应二维码", async () => {
    sendCommand.mockResolvedValue(qrResponse("qq-qr-default"));
    render(<SongAccountSettings snapshot={snapshot(false)} />);
    fireEvent.click(screen.getByRole("button", { name: /音乐账号配置/ }));

    // 点击切换到 QQ 音乐平台
    fireEvent.click(screen.getByRole("button", { name: /QQ音乐/ }));
    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith("song.auth.qr.create", {
        platform: "qq",
        type: "qq",
      });
    });
    expect(screen.getByText("请使用手机 QQ 扫码")).toBeInTheDocument();

    // 切换为微信扫码
    sendCommand.mockResolvedValueOnce(qrResponse("wx-qr"));
    fireEvent.click(screen.getByRole("button", { name: "微信扫码" }));
    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith("song.auth.qr.create", {
        platform: "qq",
        type: "wx",
      });
    });
    expect(screen.getByText("请使用微信扫码")).toBeInTheDocument();

    // 切换为 QQ 音乐 App 扫码
    sendCommand.mockResolvedValueOnce(qrResponse("mobile-qr"));
    fireEvent.click(screen.getByRole("button", { name: "QQ音乐扫码" }));
    await waitFor(() => {
      expect(sendCommand).toHaveBeenCalledWith("song.auth.qr.create", {
        platform: "qq",
        type: "mobile",
      });
    });
    expect(screen.getByText("请使用 QQ 音乐 App 扫码")).toBeInTheDocument();
  });

  it("QQ 音乐登录后正确显示超级会员 8 级徽章及到期日", () => {
    saveSongMusicSession(
      {
        cookie: "qq_token=123",
        account: {
          platform: "qq",
          nickname: "腾讯大佬",
          vipStatus: "vip",
          vipTier: "svip",
          vipLevel: 8,
          vipExpireTime: Date.UTC(2028, 5, 1, 0, 0, 0),
        },
      },
      true,
      "qq"
    );
    render(
      <SongAccountSettings
        snapshot={
          {
            roomId: "1234",
            musicAccountReady: false,
            qqMusicAccountReady: true,
          } as SonGuessrRoomSnapshot
        }
      />
    );

    const toggle = screen.getByRole("button", { name: /音乐账号配置/ });
    expect(within(toggle).getByText("腾讯大佬")).toBeInTheDocument();
    expect(within(toggle).getByRole("img", { name: "超级会员 · SVIP8" })).toHaveAttribute(
      "src",
      "/assets/qqmusic-vip/SVIP-8.png"
    );

    fireEvent.click(toggle);
    // 切换到 QQ 音乐平台查看展开详情
    fireEvent.click(screen.getByRole("button", { name: /QQ音乐/ }));
    expect(panel().getByText("腾讯大佬")).toBeInTheDocument();
    expect(panel().getByRole("img", { name: "超级会员 · SVIP8" })).toHaveAttribute(
      "src",
      "/assets/qqmusic-vip/SVIP-8.png"
    );
  });

  it("双账号同时在线时收起态标题行同时展示网易云和QQ音乐徽章", () => {
    saveSongMusicSession(
      {
        cookie: "MUSIC_U=test",
        account: {
          platform: "netease",
          nickname: "网易云达人",
          vipStatus: "vip",
          vipTier: "vip",
          vipLevel: 7,
        },
      },
      true,
      "netease"
    );
    saveSongMusicSession(
      {
        cookie: "qq_token=test",
        account: {
          platform: "qq",
          nickname: "QQ达人",
          vipStatus: "vip",
          vipTier: "vip",
          vipLevel: 8,
        },
      },
      true,
      "qq"
    );

    render(
      <SongAccountSettings
        snapshot={
          {
            roomId: "1234",
            musicAccountReady: true,
            qqMusicAccountReady: true,
          } as SonGuessrRoomSnapshot
        }
      />
    );

    const toggle = screen.getByRole("button", { name: /音乐账号配置/ });
    expect(within(toggle).getByText("网易云达人")).toBeInTheDocument();
    const neteaseBadge = within(toggle).getByRole("img", { name: "VIP · 柒" });
    expect(neteaseBadge).toHaveAttribute("src", "/assets/netease-vip/VIP-7.png");
    expect(neteaseBadge).toHaveClass("h-4");

    expect(within(toggle).getByText("QQ达人")).toBeInTheDocument();
    const qqBadge = within(toggle).getByRole("img", { name: "豪华绿钻 · LV8" });
    expect(qqBadge).toHaveAttribute("src", "/assets/qqmusic-vip/VIP-8.png");
    expect(qqBadge).toHaveClass("h-[26px]");
  });

  it("正确渲染 QQ 音乐年费绿钻6级官方徽章与年费超级会员", () => {
    saveSongMusicSession(
      {
        cookie: "qq_token=test_year",
        account: {
          platform: "qq",
          nickname: "年费达人",
          vipStatus: "vip",
          vipTier: "vip",
          vipLevel: 6,
          vipYear: true,
        },
      },
      true,
      "qq"
    );

    render(
      <SongAccountSettings
        snapshot={
          {
            roomId: "1234",
            qqMusicAccountReady: true,
          } as SonGuessrRoomSnapshot
        }
      />
    );

    const toggle = screen.getByRole("button", { name: /音乐账号配置/ });
    expect(within(toggle).getByText("年费达人")).toBeInTheDocument();
    const yearBadge = within(toggle).getByRole("img", { name: "年费绿钻 · LV6" });
    expect(yearBadge).toHaveAttribute("src", "/assets/qqmusic-vip/VIP-6-Year.png");
    expect(yearBadge).toHaveClass("h-[26px]");
  });

  it("切换到QQ音乐Tab但未登录时，折叠态网易云账号不被污染，且QQ音乐显示未配置", () => {
    saveSongMusicSession(
      {
        cookie: "MUSIC_U=test",
        account: {
          platform: "netease",
          nickname: "网易云达人",
          vipStatus: "vip",
          vipTier: "vip",
          vipLevel: 7,
        },
      },
      true,
      "netease"
    );
    render(
      <SongAccountSettings
        snapshot={
          {
            roomId: "1234",
            musicAccountReady: true,
            qqMusicAccountReady: false,
          } as SonGuessrRoomSnapshot
        }
      />
    );

    const toggle = screen.getByRole("button", { name: /音乐账号配置/ });
    expect(within(toggle).getByText("网易云达人")).toBeInTheDocument();
    expect(within(toggle).getByText("未配置")).toBeInTheDocument();

    // 展开并切换到 QQ 音乐 Tab
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /QQ音乐/ }));

    // 收起后网易云账号依然正常展示，QQ音乐依然显示未配置，不发生图标或昵称互串
    fireEvent.click(toggle);
    expect(within(toggle).getByText("网易云达人")).toBeInTheDocument();
    expect(within(toggle).getByText("未配置")).toBeInTheDocument();
  });
});
