import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SongClipPreview } from "@bakagame/shared";
import { SongClipConfig } from "./SongClipConfig";
import { clampClipRange, defaultClipRange, formatClipTime } from "./SongClipEditing";

const SONG: SongClipPreview = {
  id: "song-1",
  title: "测试歌",
  artist: "测试歌手",
  album: "测试专辑",
  durationMs: 120_000,
  audioUrl: "https://audio/test.mp3",
  lyrics: [
    { time: 10_000, endTime: 15_000, text: "第一句" },
    { time: 20_000, endTime: 25_000, text: "第二句" },
    { time: 40_000, endTime: 45_000, text: "第三句" },
    { time: 60_000, endTime: 70_000, text: "长句" },
    { time: 95_000, endTime: 100_000, text: "末句" },
  ],
};

/** jsdom 不实现媒体播放：把当前时间、暂停态与 play/pause 都换成可观察的替身。 */
function stubAudio(container: HTMLElement) {
  const audio = container.querySelector("audio");
  if (!audio) throw new Error("缺少 audio 元素");
  let currentTime = 0;
  let paused = true;
  Object.defineProperty(audio, "currentTime", {
    configurable: true,
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value;
    },
  });
  Object.defineProperty(audio, "paused", { configurable: true, get: () => paused });
  const play = vi.fn(async () => {
    paused = false;
  });
  const pause = vi.fn(() => {
    paused = true;
  });
  audio.play = play;
  audio.pause = pause;
  return {
    audio,
    play,
    pause,
    seek: (ms: number) => {
      currentTime = ms / 1_000;
    },
    now: () => currentTime * 1_000,
  };
}

describe("片段编辑的纯函数", () => {
  it("时间读数按分:秒.十分位显示", () => {
    expect(formatClipTime(0)).toBe("0:00.0");
    expect(formatClipTime(65_400)).toBe("1:05.4");
  });

  it("起止约束覆盖最短与越界", () => {
    expect(clampClipRange(10_000, 11_000, 120_000)).toEqual([10_000, 15_000]);
    expect(clampClipRange(10_000, 60_000, 120_000)).toEqual([10_000, 60_000]);
    expect(clampClipRange(-5_000, 2_000, 120_000)).toEqual([0, 5_000]);
  });

  it("默认区间优先用服务端建议，没有建议时回退副歌或首句", () => {
    expect(
      defaultClipRange({
        ...SONG,
        suggestedClip: { startTime: 40_000, endTime: 52_000 },
      })
    ).toEqual([40_000, 52_000]);
    // 建议区间短于 5 秒时按手动下限收口。
    expect(
      defaultClipRange({ ...SONG, suggestedClip: { startTime: 40_000, endTime: 42_000 } })
    ).toEqual([40_000, 45_000]);
    expect(
      defaultClipRange({ ...SONG, chorus: { startTime: 50_000, endTime: 90_000 } })
    ).toEqual([50_000, 90_000]);
    expect(defaultClipRange(SONG)).toEqual([10_000, 25_000]);
  });
});

describe("SongClipConfig", () => {
  it("点两句歌词定出区间，确认时带上同一份起止", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<SongClipConfig song={SONG} onConfirm={onConfirm} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /0:10.0 第一句/ }));
    expect(screen.getByText("已选起点，再点一句设为终点")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /0:20.0 第二句/ }));

    expect(screen.queryByText("已选起点，再点一句设为终点")).not.toBeInTheDocument();
    expect(screen.getByText(/0:10\.0 – 0:25\.0/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "用这段出题" }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ startTime: 10_000, endTime: 25_000 });
  });

  it("时间轴可以选到整首，歌词高亮跟着新区间走", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<SongClipConfig song={SONG} onConfirm={onConfirm} onCancel={vi.fn()} />);

    const endThumb = screen.getByRole("slider", { name: "片段终点" });
    endThumb.focus();
    fireEvent.keyDown(endThumb, { key: "End" });

    expect(screen.getByText("片段 110.0 秒（至少 5 秒，最长整首）")).toBeInTheDocument();
    expect(endThumb).toHaveAttribute("aria-valuetext", "2:00.0");
    expect(screen.getByRole("button", { name: /1:35\.0 末句/ })).toHaveAttribute(
      "data-selected",
      "true"
    );
    expect(screen.getByRole("button", { name: /0:10\.0 第一句/ })).toHaveAttribute(
      "data-selected",
      "true"
    );
    // 确认按钮提交的是夹紧后的整段区间。
    await user.click(screen.getByRole("button", { name: "用这段出题" }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ startTime: 10_000, endTime: 120_000 });
  });

  it("试听从片段起点开始，到终点按循环开关决定重播或暂停", async () => {
    const user = userEvent.setup();
    const view = render(
      <SongClipConfig song={SONG} onConfirm={vi.fn()} onCancel={vi.fn()} />
    );
    const audio = stubAudio(view.container);

    await user.click(screen.getByRole("button", { name: "试听片段" }));
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.now()).toBe(10_000);

    audio.seek(25_000);
    fireEvent.timeUpdate(audio.audio);
    // 默认循环：回到起点继续播，不暂停。
    expect(audio.now()).toBe(10_000);
    expect(audio.pause).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "循环" }));
    audio.seek(25_000);
    fireEvent.timeUpdate(audio.audio);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.now()).toBe(10_000);
  });

  it("出题失败的提示留在配置页，可以改完片段再试", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockRejectedValue({ message: "上游取不到音频" });
    render(<SongClipConfig song={SONG} onConfirm={onConfirm} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "用这段出题" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("上游取不到音频");
    expect(screen.getByRole("button", { name: "用这段出题" })).toBeEnabled();
  });
});
