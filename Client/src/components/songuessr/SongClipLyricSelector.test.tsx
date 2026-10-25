import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LyricLine } from "@applemusic-like-lyrics/core";
import type { SongLyricLine } from "@bakagame/shared";

const players = vi.hoisted(
  () =>
    [] as Array<{
      lines: LyricLine[];
      time: number;
      playing: boolean;
      disposed: boolean;
    }>
);

vi.mock("@applemusic-like-lyrics/core", () => ({
  LyricPlayer: class {
    lines: LyricLine[] = [];
    time = 0;
    playing = false;
    disposed = false;
    currentLyricGroups: Array<{
      element: HTMLElement;
      mainLine: { getElement: () => HTMLElement };
      show: () => void;
    }> = [];
    lyricGroupSize = new WeakMap();
    size = [0, 0];
    element = document.createElement("div");

    constructor() {
      players.push(this);
    }

    getElement() {
      return this.element;
    }

    setOverscanPx() {}
    setEnableScale() {}
    setEnableBlur() {}

    setLyricLines(lines: LyricLine[], time: number) {
      for (const group of this.currentLyricGroups) group.element.remove();
      this.lines = lines;
      this.time = time;
      this.currentLyricGroups = lines.map(() => {
        const element = document.createElement("div");
        const line = document.createElement("div");
        element.append(line);
        return {
          element,
          mainLine: { getElement: () => line },
          show: () => {
            if (!element.parentElement) this.element.append(element);
          },
        };
      });
    }

    setCurrentTime(time: number) {
      this.time = time;
    }

    getIsPlaying() {
      return this.playing;
    }

    pause() {
      this.playing = false;
    }

    resume() {
      this.playing = true;
    }

    calcLayout() {
      return Promise.resolve();
    }

    update() {}

    dispose() {
      this.disposed = true;
      this.element.remove();
    }
  },
}));

import { SongClipLyricSelector } from "./SongClipLyricSelector";

const lines: SongLyricLine[] = [
  {
    time: 10_000,
    endTime: 15_000,
    text: "逐字句",
    words: [
      { startTime: 10_000, endTime: 12_000, word: "逐字" },
      { startTime: 12_000, endTime: 15_000, word: "句" },
    ],
  },
  { time: 20_000, endTime: 25_000, text: "普通句" },
  { time: 30_000, endTime: 35_000, text: "未选句" },
];

beforeEach(() => {
  players.length = 0;
});

describe("SongClipLyricSelector", () => {
  it("按原始逐字能力标记行，并同步区间和起点状态", () => {
    const { rerender } = render(
      <SongClipLyricSelector
        lines={lines}
        range={[10_000, 25_000]}
        anchorIndex={0}
        onPick={vi.fn()}
      />
    );
    const timed = screen.getByRole("button", { name: "0:10.0 逐字句" });
    const plain = screen.getByRole("button", { name: "0:20.0 普通句" });
    expect(timed).toHaveAttribute("data-word-timed", "true");
    expect(plain).toHaveAttribute("data-word-timed", "false");
    expect(timed).toHaveAttribute("data-selected", "true");
    expect(timed).toHaveAttribute("data-anchor", "true");
    expect(plain).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("button", { name: "0:30.0 未选句" })).not.toHaveAttribute(
      "data-selected"
    );

    rerender(
      <SongClipLyricSelector
        lines={lines}
        range={[30_000, 35_000]}
        anchorIndex={null}
        onPick={vi.fn()}
      />
    );
    expect(timed).not.toHaveAttribute("data-selected");
    expect(timed).not.toHaveAttribute("data-anchor");
    expect(screen.getByRole("button", { name: "0:30.0 未选句" })).toHaveAttribute(
      "data-selected",
      "true"
    );
  });

  it("点击、回车和空格都提交同一个原始行索引", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <SongClipLyricSelector
        lines={lines}
        range={[10_000, 25_000]}
        anchorIndex={null}
        onPick={onPick}
      />
    );
    const first = screen.getByRole("button", { name: "0:10.0 逐字句" });
    await user.click(screen.getByRole("button", { name: "0:20.0 普通句" }));
    expect(onPick).toHaveBeenLastCalledWith(1);
    first.focus();
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenLastCalledWith(0);
    await user.keyboard(" ");
    expect(onPick).toHaveBeenLastCalledWith(0);
    expect(onPick).toHaveBeenCalledTimes(3);
  });

  it("内容快照不重建节点，逐字内容变化仍更新", () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <SongClipLyricSelector
        lines={lines}
        range={[10_000, 25_000]}
        anchorIndex={null}
        onPick={onPick}
      />
    );
    const original = screen.getByRole("button", { name: "0:10.0 逐字句" });
    rerender(
      <SongClipLyricSelector
        lines={structuredClone(lines)}
        range={[10_000, 25_000]}
        anchorIndex={null}
        onPick={onPick}
      />
    );
    expect(screen.getByRole("button", { name: "0:10.0 逐字句" })).toBe(original);
    const changed = structuredClone(lines);
    changed[0]!.text = "改后句";
    changed[0]!.words![1]!.word = "改后";
    rerender(
      <SongClipLyricSelector
        lines={changed}
        range={[10_000, 25_000]}
        anchorIndex={null}
        onPick={onPick}
      />
    );
    expect(screen.getByRole("button", { name: "0:10.0 改后句" })).toBeInTheDocument();
    expect(players.at(-1)!.lines[0]!.words[1]!.word).toBe("改后");
  });
});
