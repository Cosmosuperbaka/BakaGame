import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SongClipPreview } from "@bakagame/shared";
import { SongClipEditor } from "./SongClipEditor";
import { clampClipRange, defaultClipRange, formatClipTime } from "./SongClipEditing";
import type { SongClipLyricSheetProps } from "./SongClipLyricSheet";

vi.mock("./SongClipLyricSheet", async () => {
  const { formatClipTime } = await import("./SongClipEditing");
  return {
    SongClipLyricSheet: ({ lines, range, anchorIndex, onPick }: SongClipLyricSheetProps) => (
      <div>
        {lines.map((line, index) => (
          <button
            key={`${line.time}-${index}`}
            type="button"
            data-line-index={index}
            data-selected={line.time < range[1] && line.endTime > range[0] ? "true" : undefined}
            data-anchor={index === anchorIndex ? "true" : undefined}
            aria-label={`${formatClipTime(line.time)} ${line.text}`}
            onClick={() => onPick(index)}
          >
            {line.text}
          </button>
        ))}
      </div>
    ),
  };
});

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
    expect(
      defaultClipRange({ ...SONG, suggestedClip: { startTime: 40_000, endTime: 42_000 } })
    ).toEqual([40_000, 45_000]);
    expect(defaultClipRange({ ...SONG, chorus: { startTime: 50_000, endTime: 90_000 } })).toEqual([
      50_000, 90_000,
    ]);
    expect(defaultClipRange(SONG)).toEqual([10_000, 25_000]);
  });
});

describe("SongClipEditor", () => {
  it("点两句歌词定出区间，确认时带上同一份起止", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<SongClipEditor song={SONG} onConfirm={onConfirm} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /0:10.0 第一句/ }));
    expect(await screen.findByText("已点一句 0:10.0，再点另一句定起止")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /0:20.0 第二句/ }));

    expect(await screen.findByText("点两句歌词定起止，拖动截取条可微调")).toBeInTheDocument();
    expect(screen.getByText(/0:10\.0 – 0:25\.0/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "用这段出题" }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ startTime: 10_000, endTime: 25_000 });
  });

  it("截取轨可以用键盘选到整首，歌词高亮跟着新区间走", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<SongClipEditor song={SONG} onConfirm={onConfirm} onCancel={vi.fn()} />);

    const endHandle = screen.getByRole("slider", { name: "片段终点" });
    endHandle.focus();
    fireEvent.keyDown(endHandle, { key: "End" });

    expect(screen.getByText("110.0 秒")).toBeInTheDocument();
    expect(screen.getByText(/0:10\.0 – 2:00\.0/)).toBeInTheDocument();
    expect(endHandle).toHaveAttribute("aria-valuetext", "2:00.0");
    expect(screen.getByRole("button", { name: /1:35\.0 末句/ })).toHaveAttribute(
      "data-selected",
      "true"
    );
    expect(screen.getByRole("button", { name: /0:10\.0 第一句/ })).toHaveAttribute(
      "data-selected",
      "true"
    );
    await user.click(screen.getByRole("button", { name: "用这段出题" }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ startTime: 10_000, endTime: 120_000 });
  });

  it("试听从片段起点开始，到终点停下并回到起点", async () => {
    const user = userEvent.setup();
    const view = render(<SongClipEditor song={SONG} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const audio = stubAudio(view.container);

    await user.click(screen.getByRole("button", { name: "试听片段" }));
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.now()).toBe(10_000);

    audio.seek(15_000);
    fireEvent.timeUpdate(audio.audio);
    const progress = screen.getByTestId("song-clip-play-progress");
    expect(parseFloat(progress.style.left)).toBeCloseTo((10_000 / 120_000) * 100, 4);
    expect(parseFloat(progress.style.width)).toBeCloseTo((5_000 / 120_000) * 100, 4);

    audio.seek(25_000);
    fireEvent.timeUpdate(audio.audio);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.now()).toBe(10_000);
    expect(screen.getByRole("button", { name: "试听片段" })).toBeInTheDocument();
  });

  it("播放位置滑轨可用键盘在片段内微调", () => {
    const view = render(<SongClipEditor song={SONG} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const audio = stubAudio(view.container);

    const seek = screen.getByRole("slider", { name: "播放位置" });
    seek.focus();
    fireEvent.keyDown(seek, { key: "ArrowRight" });
    expect(audio.now()).toBe(11_000);
    expect(seek).toHaveAttribute("aria-valuenow", "11000");

    fireEvent.keyDown(seek, { key: "End" });
    expect(audio.now()).toBe(25_000);
    expect(seek).toHaveAttribute("aria-valuenow", "25000");
  });

  it("出题失败的提示留在配置页，可以改完片段再试", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockRejectedValue({ message: "上游取不到音频" });
    render(<SongClipEditor song={SONG} onConfirm={onConfirm} onCancel={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "用这段出题" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("上游取不到音频");
    expect(screen.getByRole("button", { name: "用这段出题" })).toBeEnabled();
  });
});
