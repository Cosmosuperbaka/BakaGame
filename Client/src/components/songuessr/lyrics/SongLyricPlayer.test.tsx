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

  it("音频播放完毕时自动切换为纯净歌词总览视图（原生 AMLL 总览、自适应高度、平滑缩放）", () => {
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

    const container = screen.getByTestId("baka-song-lyric-container");
    const height = parseInt(container.style.height, 10);
    // 无布局环境（jsdom）下退回解析式估算：主行 21.6 + 副行 22.24 + 组上下内边距 9 + 容差 2
    // 两句内容高 87.44，总览按 scale(0.92) 反向补偿 → ceil(80.44) = 81
    expect(height).toBe(81);

    const overview = screen.getByTestId("baka-song-lyric-overview");
    expect(overview).toBeInTheDocument();
    expect(overview.querySelector(".baka-lyric-player")).toHaveClass("baka-overview-mode");
    expect(screen.queryByText("题目歌词总览")).toBeNull();
    expect(screen.queryByText(/重播可再次查看/)).toBeNull();

    expect(screen.getByText(/选中的第一句歌词/)).toBeInTheDocument();
  });

  it("当歌词同时有翻译和注音时，注音被屏蔽只保留翻译", () => {
    const lines: SongLyricLine[] = [
      {
        time: 1000,
        endTime: 3000,
        text: "何も言わないで",
        translatedLyric: "缄默不言",
        romanLyric: "na ni mo i wa na i de",
        words: [
          { startTime: 1000, endTime: 2000, word: "何も", romanWord: "na ni mo" },
          { startTime: 2000, endTime: 3000, word: "言わないで", romanWord: "i wa na i de" },
        ],
      },
    ];

    render(<SongLyricPlayer lines={lines} audioPlaybackState="playing" />);
    // 界面上可见翻译
    expect(screen.getByText(/缄默不言/)).toBeInTheDocument();
    // 注音文本不显示
    expect(screen.queryByText(/na ni mo/)).toBeNull();
  });

  it("无歌词或空数组时显示紧凑型纯音乐提示", () => {
    render(<SongLyricPlayer lines={[]} />);
    const emptyEl = screen.getByTestId("baka-song-lyric-empty");
    expect(emptyEl).toBeInTheDocument();
    expect(emptyEl).toHaveClass("h-24");
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

  it("当外部传入相同内容的新 lines 数组引用时保持稳定渲染，阻止虚假重刷", () => {
    const lines1: SongLyricLine[] = [
      { time: 1000, endTime: 3000, text: "稳定歌词" },
    ];
    const { rerender } = render(<SongLyricPlayer lines={lines1} />);
    expect(screen.getByTestId("baka-song-lyric-player")).toBeInTheDocument();

    const lines2: SongLyricLine[] = [
      { time: 1000, endTime: 3000, text: "稳定歌词" },
    ];
    rerender(<SongLyricPlayer lines={lines2} audioStatus="ready" />);
    expect(screen.getByTestId("baka-song-lyric-player")).toBeInTheDocument();
  });

  it("当包含多行双语翻译歌词时按真实盒模型精确扩展容器高度，杜绝总览溢出或无效留白", () => {
    const lines: SongLyricLine[] = [
      { time: 1000, endTime: 3000, text: "夜空に浮かぶ星たち", translatedLyric: "浮现在夜空中的群星点点" },
      { time: 3000, endTime: 6000, text: "静寂を切り裂いていく", translatedLyric: "将这无尽的寂静一点点撕裂开来" },
      { time: 6000, endTime: 9000, text: "いつか届くはずの想い", translatedLyric: "总有一天这份思念能够传达到你的身边" },
      { time: 9000, endTime: 12000, text: "未来へと紡いでいく", translatedLyric: "交织着向未知的未来不断延伸" },
    ];

    render(<SongLyricPlayer lines={lines} audioPlaybackState="completed" />);
    const container = screen.getByTestId("baka-song-lyric-container");
    const height = parseInt(container.style.height, 10);
    // 4 组「主行 + 翻译」各 54.84 → 219.36，按 scale(0.92) 反向补偿 → ceil(201.8) = 202
    expect(height).toBe(202);
  });

  it("当包含和声伴唱歌词（isBG）时精确核算其高度预算", () => {
    const linesWithBG: SongLyricLine[] = [
      { time: 1000, endTime: 3000, text: "主歌词第一行" },
      { time: 1500, endTime: 2500, text: "和声伴唱小字 (Yeah~)", isBG: true },
      { time: 3000, endTime: 5000, text: "主歌词第二行" },
    ];

    render(<SongLyricPlayer lines={linesWithBG} audioPlaybackState="completed" />);
    const container = screen.getByTestId("baka-song-lyric-container");
    const height = parseInt(container.style.height, 10);
    // 主行组 32.6 + 主行挂载和声组(32.6 + 组内间距 3.6 + 和声小字 15.12) = 83.92，
    // 按 scale(0.92) 反向补偿 → ceil(77.2) = 78
    expect(height).toBe(78);
  });

  it("音频在首句前缓冲区间（如提前 1 秒前奏）播放时，歌词正常挂载且不提前触发首句完成状态", () => {
    const lines: SongLyricLine[] = [
      { time: 35000, endTime: 40000, text: "副歌第一句" },
      { time: 40000, endTime: 45000, text: "副歌第二句" },
    ];

    const mockAudio = document.createElement("audio");
    mockAudio.currentTime = 34; // 34 秒，比首句 35 秒提前 1 秒
    Object.defineProperty(mockAudio, "paused", { value: false, writable: true });
    Object.defineProperty(mockAudio, "ended", { value: false, writable: true });

    const audioRef = createRef<HTMLAudioElement | null>();
    audioRef.current = mockAudio;

    const { container } = render(
      <SongLyricPlayer
        lines={lines}
        audioRef={audioRef}
        audioPlaybackState="playing"
        audioStatus="ready"
      />,
    );

    const playerContainer = screen.getByTestId("baka-song-lyric-player");
    expect(playerContainer).toBeInTheDocument();
    expect(container.querySelector(".baka-lyric-player")).not.toBeNull();
  });
});



