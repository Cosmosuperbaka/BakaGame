import { describe, expect, it } from "vitest";
import {
  LYRIC_OVERVIEW_SCALE,
  calculateLyricContainerHeight,
  estimateLyricOverviewHeight,
  measureLyricOverviewHeight,
  readMeasuredGroupHeights,
} from "./lyricHeight";
import type { SongLyricLine } from "@/types";

const line = (text: string, extra: Partial<SongLyricLine> = {}): SongLyricLine => ({
  time: 0,
  endTime: 1000,
  text,
  ...extra,
});

interface FakeGroup {
  element: { isConnected: boolean; clientHeight: number };
}

/**
 * 造一个 AMLL 内核歌词组替身：只暴露高度核算真正读取的
 * `currentLyricGroups` / `lyricGroupSize` 与元素 `clientHeight`。
 */
function fakePlayer(measured: (number | null)[], live?: (number | null)[]) {
  const groups: FakeGroup[] = measured.map((height, index) => ({
    element: { isConnected: true, clientHeight: live?.[index] ?? height ?? 0 },
  }));
  const lyricGroupSize = new WeakMap<object, [number, number]>();
  groups.forEach((group, index) => {
    const height = measured[index];
    if (height !== null) lyricGroupSize.set(group, [600, height]);
  });
  return { currentLyricGroups: groups, lyricGroupSize } as never;
}

describe("estimateLyricOverviewHeight", () => {
  it("无歌词时返回 0", () => {
    expect(estimateLyricOverviewHeight([], 560)).toBe(0);
  });

  it("单句短歌词 = 上下内边距 9 + 行高 21.6 + 容差 2", () => {
    expect(estimateLyricOverviewHeight([line("第一句普通歌词")], 560)).toBeCloseTo(32.6, 5);
  });

  it("翻译副行按 0.85rem / line-height 1.4 并叠加 margin-top .2rem 计入", () => {
    const withTranslation = estimateLyricOverviewHeight(
      [line("夜空に浮かぶ星たち", { translatedLyric: "浮现在夜空中的群星点点" })],
      560,
    );
    expect(withTranslation - estimateLyricOverviewHeight([line("夜空に浮かぶ星たち")], 560)).toBeCloseTo(
      3.2 + 19.04,
      5,
    );
  });

  it("超长歌词按容器可用宽度折算折行行数，行高成倍增长", () => {
    const long =
      "这是一句特别特别长的歌词用来验证在容器宽度有限的时候是否会发生折行从而让整段歌词总览高度大幅增加的情况";
    const availableWidth = 606 - 18 * 2 - 18 * 2;
    const expectedLines = Math.ceil([...long].length / (availableWidth / 18));
    expect(expectedLines).toBe(2);
    expect(estimateLyricOverviewHeight([line(long)], 606 - 36)).toBeCloseTo(9 + expectedLines * 21.6 + 2, 5);
  });

  it("和声伴唱（isBG）并入前一句主歌词组，按 0.7em 小字与组内间距核算", () => {
    const withBackground = estimateLyricOverviewHeight(
      [line("主歌词第一行"), line("和声伴唱小字 (Yeah~)", { isBG: true }), line("主歌词第二行")],
      560,
    );
    // 主行组 32.6 + 挂载和声组(32.6 + 组内间距 3.6 + 和声小字 15.12)
    expect(withBackground).toBeCloseTo(32.6 + 32.6 + 3.6 + 15.12, 5);
  });
});

describe("calculateLyricContainerHeight", () => {
  const lines = [line("选中的第一句歌词", { translatedLyric: "Translation 1" })];

  it("总览模式按 scale(0.92) 反向补偿，并叠加外壳真实上下内边距", () => {
    const content = estimateLyricOverviewHeight(lines, 560);
    expect(
      calculateLyricContainerHeight({ lines, contentWidth: 560, containerPadding: 34, overview: true }),
    ).toBe(Math.ceil(content * LYRIC_OVERVIEW_SCALE + 34));
  });

  it("非总览模式不做缩放补偿", () => {
    const content = estimateLyricOverviewHeight(lines, 560);
    expect(
      calculateLyricContainerHeight({ lines, contentWidth: 560, containerPadding: 34 }),
    ).toBe(Math.ceil(content + 34));
  });

  it("原生实测值优先于解析式估算", () => {
    expect(
      calculateLyricContainerHeight({
        lines,
        contentWidth: 560,
        containerPadding: 34,
        measuredContentHeight: 200,
        overview: true,
      }),
    ).toBe(Math.ceil(200 * LYRIC_OVERVIEW_SCALE) + 34);
  });

  it("内容宽度不足时退回兜底宽度，不会算出 0 高", () => {
    expect(
      calculateLyricContainerHeight({ lines, contentWidth: 0, containerPadding: 34, overview: true }),
    ).toBeGreaterThan(34);
  });
});

describe("measureLyricOverviewHeight", () => {
  it("缺少歌词组或测量表时返回 null", () => {
    expect(measureLyricOverviewHeight(null)).toBeNull();
    expect(measureLyricOverviewHeight(undefined)).toBeNull();
    expect(measureLyricOverviewHeight({ currentLyricGroups: [] } as never)).toBeNull();
  });

  it("任一歌词组未测量时返回 null，交由下一帧重试", () => {
    expect(readMeasuredGroupHeights(fakePlayer([53, null]))).toBeNull();
    expect(measureLyricOverviewHeight(fakePlayer([53, null]))).toBeNull();
  });

  it("测量值与元素当前 clientHeight 不一致（旧值残留）时返回 null", () => {
    expect(measureLyricOverviewHeight(fakePlayer([53, 31], [53, 27]))).toBeNull();
  });

  it("歌词组元素未挂载到 DOM（未进入视野）时返回 null", () => {
    const player = fakePlayer([53]) as unknown as { currentLyricGroups: FakeGroup[] };
    player.currentLyricGroups[0].element.isConnected = false;
    expect(measureLyricOverviewHeight(player as never)).toBeNull();
  });

  it("测量齐全且与元素一致时返回各组实测高度之和", () => {
    const player = fakePlayer([53, 31]);
    expect(readMeasuredGroupHeights(player)).toEqual([53, 31]);
    expect(measureLyricOverviewHeight(player)).toBe(84);
  });
});
