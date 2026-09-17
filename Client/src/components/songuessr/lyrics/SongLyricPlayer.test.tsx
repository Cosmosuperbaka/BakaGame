import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { SongLyricPlayer } from "./SongLyricPlayer";
import type { SongLyricLine } from "@/types";

describe("SongLyricPlayer", () => {
  it("无歌词或空数组时显示纯音乐提示", () => {
    render(<SongLyricPlayer lines={[]} />);
    expect(screen.getByTestId("baka-song-lyric-empty")).toBeInTheDocument();
    expect(screen.getByText("当前歌曲为纯音乐或无歌词")).toBeInTheDocument();
  });

  it("普通行级歌词（无逐字 words）时正常渲染并回退到单词全行映射", () => {
    const lines: SongLyricLine[] = [
      { time: 1000, endTime: 4000, text: "第一行普通歌词" },
      { time: 4000, endTime: 8000, text: "第二行普通歌词" },
    ];

    const { container } = render(<SongLyricPlayer lines={lines} />);
    const playerContainer = screen.getByTestId("baka-song-lyric-player");
    expect(playerContainer).toBeInTheDocument();
    expect(container.querySelector(".baka-lyric-player")).not.toBeNull();
  });

  it("包含逐字 words 歌词时正常渲染并结合 audioRef 监听时间轴事件", () => {
    const lines: SongLyricLine[] = [
      {
        time: 1000,
        endTime: 4000,
        text: "故事的小黄花",
        words: [
          { startTime: 1000, endTime: 2500, word: "故事的" },
          { startTime: 2500, endTime: 4000, word: "小黄花" },
        ],
      },
    ];

    const mockAudio = document.createElement("audio");
    const addEventListenerSpy = vi.spyOn(mockAudio, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(mockAudio, "removeEventListener");

    const audioRef = createRef<HTMLAudioElement | null>();
    audioRef.current = mockAudio;

    const { unmount } = render(<SongLyricPlayer lines={lines} audioRef={audioRef} />);
    expect(screen.getByTestId("baka-song-lyric-player")).toBeInTheDocument();

    expect(addEventListenerSpy).toHaveBeenCalledWith("play", expect.any(Function));
    expect(addEventListenerSpy).toHaveBeenCalledWith("pause", expect.any(Function));
    expect(addEventListenerSpy).toHaveBeenCalledWith("timeupdate", expect.any(Function));

    unmount();
    expect(removeEventListenerSpy).toHaveBeenCalledWith("play", expect.any(Function));
    expect(removeEventListenerSpy).toHaveBeenCalledWith("pause", expect.any(Function));
    expect(removeEventListenerSpy).toHaveBeenCalledWith("timeupdate", expect.any(Function));
  });
});
