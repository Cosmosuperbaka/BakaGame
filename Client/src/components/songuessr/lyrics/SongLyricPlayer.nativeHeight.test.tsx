import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { CSSProperties, Ref } from "react";
import type { SongLyricLine } from "@/types";
import { SongLyricPlayer } from "./SongLyricPlayer";

/**
 * AMLL 播放器替身：只暴露高度核算真正读取的原生字段
 * （`currentLyricGroups` / `lyricGroupSize` / 元素 `clientHeight`）。
 */
const holder = vi.hoisted(() => ({ player: undefined as unknown }));

vi.mock("@applemusic-like-lyrics/react", async () => {
  const React = await import("react");
  return {
    LyricPlayer: React.forwardRef(function MockLyricPlayer(
      props: { className?: string; style?: CSSProperties },
      ref: Ref<unknown>,
    ) {
      React.useImperativeHandle(ref, () => ({ lyricPlayer: holder.player, wrapperEl: null }));
      return <div data-testid="mock-amll" className={props.className} style={props.style} />;
    }),
  };
});

const LINES: SongLyricLine[] = [
  { time: 1000, endTime: 3000, text: "选中的第一句歌词", translatedLyric: "Translation 1" },
  { time: 3000, endTime: 6000, text: "选中的第二句歌词" },
];

interface FakeGroup {
  element: { isConnected: boolean; clientHeight: number };
}

function fakePlayer(measured: (number | null)[], live?: (number | null)[]) {
  const groups: FakeGroup[] = measured.map((height, index) => ({
    element: { isConnected: true, clientHeight: live?.[index] ?? height ?? 0 },
  }));
  const lyricGroupSize = new WeakMap<object, [number, number]>();
  groups.forEach((group, index) => {
    const height = measured[index];
    if (height !== null) lyricGroupSize.set(group, [600, height]);
  });
  return {
    currentLyricGroups: groups,
    lyricGroupSize,
    setAlignAnchor: vi.fn(),
    setAlignPosition: vi.fn(),
    setCurrentTime: vi.fn(),
    resetScroll: vi.fn(),
    calcLayout: vi.fn().mockResolvedValue(undefined),
  };
}

const container = () => screen.getByTestId("baka-song-lyric-container");
const playerHeightVar = () =>
  screen.getByTestId("mock-amll").style.getPropertyValue("--baka-lyric-player-height");

describe("SongLyricPlayer 原生实测总览高度", () => {
  it("总览高度取 AMLL 原生实测的 Σ 行高，并按 scale(0.92) 反向补偿外壳", async () => {
    holder.player = fakePlayer([53, 31]);

    render(<SongLyricPlayer lines={LINES} audioPlaybackState="completed" />);

    await waitFor(() => expect(container().style.height).toBe("78px"));
    // 播放器本体保持未缩放的自然高度，才能既不被裁切又不留留白
    expect(playerHeightVar()).toBe("84px");
  });

  it("歌词组测量未就绪时退回解析式估算，测量到位后自动收敛到实测值", async () => {
    const player = fakePlayer([null, null]);
    holder.player = player;

    render(<SongLyricPlayer lines={LINES} audioPlaybackState="completed" />);

    // 未测量：解析式估算（内容 87.44 → ceil(87.44 × 0.92) = 81）
    expect(container().style.height).toBe("81px");
    expect(playerHeightVar()).toBe("87px");

    // 内核 ResizeObserver 完成测量后，下一帧自动切换为实测值
    player.currentLyricGroups.forEach((group, index) => {
      group.element.clientHeight = index === 0 ? 53 : 31;
      player.lyricGroupSize.set(group, [600, index === 0 ? 53 : 31]);
    });

    await waitFor(() => expect(container().style.height).toBe("78px"));
    expect(playerHeightVar()).toBe("84px");
  });

  it("旧测量值残留（与元素当前高度不一致）时不采信，继续使用估算值", async () => {
    holder.player = fakePlayer([53, 31], [53, 27]);

    render(<SongLyricPlayer lines={LINES} audioPlaybackState="completed" />);
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(container().style.height).toBe("81px");
  });

  it("播放中不做缩放补偿，进入总览后按原生实测值收紧并补偿缩放", async () => {
    holder.player = fakePlayer([53, 31]);

    const { rerender } = render(<SongLyricPlayer lines={LINES} audioPlaybackState="playing" />);
    expect(container().style.height).toBe("88px");

    rerender(<SongLyricPlayer lines={LINES} audioPlaybackState="completed" />);
    await waitFor(() => expect(container().style.height).toBe("78px"));
  });
});
