import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearStoredSongMusicSession, saveSongMusicSession } from "@/lib/SonGuessrMusicSession";
import type { SongGuessrRoomSnapshot } from "@/types";
import { useSonGuessrStore, type SonGuessrStore } from "@/stores/UseSonGuessrStore";
import { SongAccountSettings } from "./SongAccountSettings";

const snapshot = (musicAccountReady: boolean) => ({
  roomId: "1234",
  musicAccountReady,
} as SongGuessrRoomSnapshot);

describe("SongAccountSettings", () => {
  let sendCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearStoredSongMusicSession();
    sendCommand = vi.fn();
    useSonGuessrStore.setState({
      sendCommand: sendCommand as unknown as SonGuessrStore["sendCommand"],
      setNotice: vi.fn(),
    });
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

  it("登录后显示会员状态，并为非会员提示会员歌曲限制", () => {
    saveSongMusicSession({
      cookie: "MUSIC_U=browser-only",
      account: { nickname: "普通账号", vipStatus: "nonVip" },
    }, true);
    render(<SongAccountSettings snapshot={snapshot(true)} />);

    fireEvent.click(screen.getByRole("button", { name: /网易云账号/ }));

    expect(screen.getByText("非会员")).toBeInTheDocument();
    expect(screen.getByText("当前账号不是会员，无法选择会员专享歌曲。")).toBeInTheDocument();
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
