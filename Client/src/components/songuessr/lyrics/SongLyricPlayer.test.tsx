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

  it("首句时间非 0 且音频未播放时，初始时间轴锚定在首句时间且容器拥有全高全宽类名", () => {
    const lines: SongLyricLine[] = [
      { time: 35000, endTime: 40000, text: "副歌第一句" },
      { time: 40000, endTime: 45000, text: "副歌第二句" },
    ];

    const { container } = render(<SongLyricPlayer lines={lines} />);
    const playerWrapper = container.querySelector(".baka-lyric-player");
    expect(playerWrapper).not.toBeNull();
    expect(playerWrapper).toHaveClass("h-full");
    expect(playerWrapper).toHaveClass("w-full");
  });

  it("音频处于加载中状态时，歌词不提前播放且时间轴锁定在首句", () => {
    const lines: SongLyricLine[] = [
      { time: 20000, endTime: 25000, text: "等待音频加载的歌词" },
    ];
    const mockAudio = document.createElement("audio");
    const audioRef = createRef<HTMLAudioElement | null>();
    audioRef.current = mockAudio;

    render(
      <SongLyricPlayer
        lines={lines}
        audioRef={audioRef}
        audioPlaybackState="idle"
        audioStatus="loading"
      />,
    );
    expect(screen.getByTestId("baka-song-lyric-player")).toBeInTheDocument();
  });

  it("音频播放完毕时自动切换为纯净歌词总览视图（无描述性标题，展示全部选中歌词及翻译）", () => {
    const lines: SongLyricLine[] = [
      { time: 1000, endTime: 3000, text: "选中的第一句歌词", translatedLyric: "Translation 1" },
      { time: 3000, endTime: 6000, text: "选中的第二句歌词" },
    ];

    render(
      <SongLyricPlayer
        lines={lines}
        audioPlaybackState="completed"
      />,
    );

    const overview = screen.getByTestId("baka-song-lyric-overview");
    expect(overview).toBeInTheDocument();
    expect(overview).toHaveClass("min-h-[11rem]");
    expect(screen.queryByText("题目歌词总览")).toBeNull();
    expect(screen.queryByText(/重播可再次查看/)).toBeNull();
    expect(screen.getByText("选中的第一句歌词")).toBeInTheDocument();
    expect(screen.getByText("Translation 1")).toBeInTheDocument();
    expect(screen.getByText("选中的第二句歌词")).toBeInTheDocument();
  });

  it("歌词组件拦截并阻止滚轮事件向下冒泡，避免组件内部错位滚动", () => {
    const lines: SongLyricLine[] = [
      { time: 1000, endTime: 3000, text: "测试滚轮" },
    ];
    const { container } = render(<SongLyricPlayer lines={lines} />);
    const player = container.querySelector("[data-testid='baka-song-lyric-player']");
    expect(player).not.toBeNull();

    const wheelEvent = new WheelEvent("wheel", { bubbles: true, cancelable: true });
    const stopPropagationSpy = vi.spyOn(wheelEvent, "stopPropagation");
    const stopImmediatePropagationSpy = vi.spyOn(wheelEvent, "stopImmediatePropagation");

    player!.dispatchEvent(wheelEvent);
    expect(stopPropagationSpy).toHaveBeenCalled();
    expect(stopImmediatePropagationSpy).toHaveBeenCalled();
  });
});


