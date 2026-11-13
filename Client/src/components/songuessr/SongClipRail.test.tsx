import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SONG_CLIP_MIN_MS } from "@bakagame/shared/values";
import { SongClipRail } from "./SongClipRail";

const DOMAIN = 100_000;
/** 轨道宽 1000 像素：横坐标除以十就是百分比，百分比乘 1000 就是毫秒。 */
const RAIL_WIDTH = 1_000;

function setup(range: [number, number] = [20_000, 50_000], currentTimeMs = 30_000) {
  const onSeek = vi.fn();
  const onRangeChange = vi.fn();
  render(
    <SongClipRail
      domain={DOMAIN}
      range={range}
      currentTimeMs={currentTimeMs}
      onSeek={onSeek}
      onRangeChange={onRangeChange}
    />
  );
  const rail = screen.getByTestId("song-clip-rail");
  rail.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: RAIL_WIDTH, height: 48, right: RAIL_WIDTH, bottom: 48 }) as DOMRect;
  return {
    onSeek,
    onRangeChange,
    start: screen.getByRole("slider", { name: "片段起点" }),
    end: screen.getByRole("slider", { name: "片段终点" }),
    play: screen.getByRole("slider", { name: "播放位置" }),
  };
}

/** 像素换算：整条轨道 1000 像素对应整首歌 100 秒，一像素 100 毫秒。 */
const px = (ms: number) => ms / 100;

describe("截取条：指针拖动", () => {
  it("拖起点手柄：按 0.1 秒取整，不越过终点前留出的最短片段", () => {
    const { start, onRangeChange } = setup();
    fireEvent.pointerDown(start, { pointerId: 1, clientX: px(20_000) });
    fireEvent.pointerMove(start, { pointerId: 1, clientX: px(10_340) });
    expect(onRangeChange).toHaveBeenLastCalledWith(10_300, 50_000);

    // 拖过终点：夹在终点前最短片段处。
    fireEvent.pointerMove(start, { pointerId: 1, clientX: px(90_000) });
    expect(onRangeChange).toHaveBeenLastCalledWith(50_000 - SONG_CLIP_MIN_MS, 50_000);
    // 拖出左边界：夹到 0。
    fireEvent.pointerMove(start, { pointerId: 1, clientX: -500 });
    expect(onRangeChange).toHaveBeenLastCalledWith(0, 50_000);
    fireEvent.pointerUp(start, { pointerId: 1 });
  });

  it("拖终点手柄：同样取整，夹在起点后最短片段与整首长度之间", () => {
    const { end, onRangeChange } = setup();
    fireEvent.pointerDown(end, { pointerId: 2, clientX: px(50_000) });
    fireEvent.pointerMove(end, { pointerId: 2, clientX: px(77_740) });
    expect(onRangeChange).toHaveBeenLastCalledWith(20_000, 77_700);
    fireEvent.pointerMove(end, { pointerId: 2, clientX: px(1_000) });
    expect(onRangeChange).toHaveBeenLastCalledWith(20_000, 20_000 + SONG_CLIP_MIN_MS);
    fireEvent.pointerMove(end, { pointerId: 2, clientX: px(500_000) });
    expect(onRangeChange).toHaveBeenLastCalledWith(20_000, DOMAIN);
    fireEvent.pointerUp(end, { pointerId: 2 });
  });

  it("点或拖播放位置：只在选区内移动播放头，不改选区", () => {
    const { play, onSeek, onRangeChange } = setup();
    fireEvent.pointerDown(play, { pointerId: 3, clientX: px(35_030) });
    expect(onSeek).toHaveBeenLastCalledWith(35_000);
    fireEvent.pointerMove(play, { pointerId: 3, clientX: px(90_000) });
    expect(onSeek).toHaveBeenLastCalledWith(50_000);
    fireEvent.pointerMove(play, { pointerId: 3, clientX: px(1_000) });
    expect(onSeek).toHaveBeenLastCalledWith(20_000);
    fireEvent.pointerUp(play, { pointerId: 3 });
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it("松手后不再跟随指针；其他指针的抬起不结束当前拖动", () => {
    const { start, onRangeChange } = setup();
    fireEvent.pointerDown(start, { pointerId: 1, clientX: px(20_000) });
    fireEvent.pointerUp(start, { pointerId: 9 });
    fireEvent.pointerMove(start, { pointerId: 1, clientX: px(30_000) });
    expect(onRangeChange).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(start, { pointerId: 1 });
    onRangeChange.mockClear();
    fireEvent.pointerMove(start, { pointerId: 1, clientX: px(40_000) });
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it("鼠标右键不开始拖动", () => {
    const { start, onRangeChange } = setup();
    fireEvent.pointerDown(start, { pointerId: 1, pointerType: "mouse", button: 2 });
    fireEvent.pointerMove(start, { pointerId: 1, clientX: px(30_000) });
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it("悬停显示指针处的时间，离开轨道收起；拖动中离开不收", () => {
    const { play } = setup();
    const rail = screen.getByTestId("song-clip-rail");
    fireEvent.pointerMove(play, { clientX: px(12_300) });
    expect(screen.getByTestId("song-clip-hover-time")).toBeInTheDocument();
    fireEvent.pointerLeave(rail);
    expect(screen.queryByTestId("song-clip-hover-time")).not.toBeInTheDocument();

    fireEvent.pointerDown(play, { pointerId: 4, clientX: px(30_000) });
    fireEvent.pointerLeave(play);
    expect(screen.getByTestId("song-clip-hover-time")).toBeInTheDocument();
    fireEvent.pointerUp(play, { pointerId: 4 });
  });
});

describe("截取条：键盘", () => {
  it("起点手柄：方向键一秒、Shift 加方向键 0.1 秒，Home 到开头，越界被夹住", () => {
    const { start, onRangeChange } = setup();
    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(onRangeChange).toHaveBeenLastCalledWith(21_000, 50_000);
    fireEvent.keyDown(start, { key: "ArrowLeft", shiftKey: true });
    expect(onRangeChange).toHaveBeenLastCalledWith(19_900, 50_000);
    fireEvent.keyDown(start, { key: "Home" });
    expect(onRangeChange).toHaveBeenLastCalledWith(0, 50_000);
    fireEvent.keyDown(start, { key: "End" });
    expect(onRangeChange).toHaveBeenLastCalledWith(50_000 - SONG_CLIP_MIN_MS, 50_000);
    fireEvent.keyDown(start, { key: "PageUp" });
    expect(onRangeChange).toHaveBeenLastCalledWith(25_000, 50_000);
  });

  it("终点手柄：向右增加、End 到整首结尾", () => {
    const { end, onRangeChange } = setup();
    fireEvent.keyDown(end, { key: "ArrowUp" });
    expect(onRangeChange).toHaveBeenLastCalledWith(20_000, 51_000);
    fireEvent.keyDown(end, { key: "End" });
    expect(onRangeChange).toHaveBeenLastCalledWith(20_000, DOMAIN);
  });

  it("播放位置：方向键在选区内移动，其余按键不处理", () => {
    const { play, onSeek } = setup();
    fireEvent.keyDown(play, { key: "ArrowRight" });
    expect(onSeek).toHaveBeenLastCalledWith(31_000);
    fireEvent.keyDown(play, { key: "Home" });
    expect(onSeek).toHaveBeenLastCalledWith(20_000);
    onSeek.mockClear();
    fireEvent.keyDown(play, { key: "a" });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("三个滑块的 aria 值反映起点、终点与播放位置", () => {
    const { start, end, play } = setup();
    expect(start).toHaveAttribute("aria-valuenow", "20000");
    expect(end).toHaveAttribute("aria-valuenow", "50000");
    expect(end).toHaveAttribute("aria-valuemax", String(DOMAIN));
    expect(play).toHaveAttribute("aria-valuenow", "30000");
    expect(play).toHaveAttribute("aria-valuemin", "20000");
    expect(play).toHaveAttribute("aria-valuemax", "50000");
  });
});
