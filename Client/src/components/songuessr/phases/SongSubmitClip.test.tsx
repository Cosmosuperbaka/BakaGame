import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SongClipPreview, SongSearchResult } from "@bakagame/shared";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { submittingSnapshot, submitterPrivate } from "@/stories/fixtures/SonGuessr";
import { GameStage, type SongGameAreaProps } from "./SongGameStage";

const initialState = useSonGuessrStore.getState();
afterEach(() => {
  useSonGuessrStore.setState(initialState, true);
});

const SONG: SongSearchResult = { id: "song-1", title: "测试歌", artist: "测试歌手" };
const PREVIEW: SongClipPreview = {
  ...SONG,
  album: "测试专辑",
  durationMs: 120_000,
  audioUrl: "https://audio/test.mp3",
  suggestedClip: { startTime: 60_000, endTime: 75_000 },
  lyrics: [
    { time: 10_000, endTime: 15_000, text: "第一句" },
    { time: 20_000, endTime: 25_000, text: "第二句" },
  ],
};

/** 房间命中出题阶段：PEACH 待出题且可以提交。 */
function stageProps(overrides: Partial<SongGameAreaProps>): SongGameAreaProps {
  return {
    snapshot: submittingSnapshot(),
    privateState: submitterPrivate({ canSubmitSong: true }),
    isHost: false,
    volume: 0.5,
    onVolumeChange: vi.fn(),
    audioStatus: "ready",
    audioPlaybackState: "idle",
    onPlayAudio: vi.fn(),
    onRetryAudio: vi.fn(),
    onSelectSearchSong: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    isPending: () => false,
    ...overrides,
  };
}

describe("手动出题的片段配置", () => {
  it("选中歌曲后先取预览再出题，提交时带上确认的起止时间", async () => {
    const user = userEvent.setup();
    const sendCommand = vi.fn(async (type: string) =>
      type === "song.music.detail" ? { song: PREVIEW } : {}
    );
    useSonGuessrStore.setState({
      sendCommand: sendCommand as never,
      searchMusic: vi.fn().mockResolvedValue([SONG]) as never,
    });
    const onSelectSearchSong = vi.fn(async () => {});
    render(<GameStage {...stageProps({ onSelectSearchSong })} />);

    await user.type(screen.getByRole("combobox", { name: "搜索歌曲" }), "测试");
    await act(
      () =>
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, 400);
        })
    );
    await user.click(await screen.findByRole("option", { name: /测试歌/ }));

    // 配置页出现前必须先拿到详情：播放 / 切片段都靠它，不能拿搜索结果凑合。
    expect(sendCommand).toHaveBeenCalledWith(
      "song.music.detail",
      { songId: "song-1" },
      { timeout: 0 }
    );
    expect(await screen.findByText("时间轴")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "用这段出题" }));
    expect(onSelectSearchSong).toHaveBeenCalledExactlyOnceWith("song-1", "submit", undefined, {
      startTime: 60_000,
      endTime: 75_000,
    });
  });
});
