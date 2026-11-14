import { describe, expect, test } from "bun:test";
import { createSongLyricClip } from "../../src/application/songuessr/LyricClip";
import { SongLyricLine } from "../../src/shared/SonGuessr";

describe("SonGuessrService", () => {
  test("歌词不足或歌词跨度过长时降级为固定时长随机片段", () => {
    const fallback = createSongLyricClip([], 5, { nextInt: () => 12_345 }, 180_000);
    expect(fallback).toEqual({ startTime: 12_345, endTime: 42_345, lines: [] });

    const insufficient = createSongLyricClip(
      [{ time: 10_000, endTime: 14_000, text: "仅有一句" }],
      5,
      { nextInt: () => 7_000 },
      180_000
    );
    expect(insufficient).toEqual({ startTime: 7_000, endTime: 37_000, lines: [] });

    const longLineFallback = createSongLyricClip(
      [{ time: 10_000, endTime: 30_001, text: "跨度过长" }],
      1,
      { nextInt: () => 5_000 },
      60_000
    );
    expect(longLineFallback).toEqual({ startTime: 5_000, endTime: 11_000, lines: [] });

    const shortSong = createSongLyricClip([], 5, { nextInt: () => 0 }, 12_000);
    expect(shortSong).toEqual({ startTime: 0, endTime: 12_000, lines: [] });
  });

  test("间奏造成的长行只会收缩歌词窗口，不会让整首歌丢失歌词", () => {
    // JANE DOE（米津玄師 / 宇多田ヒカル）实测：第 6 句之后有 15 秒间奏，
    // 该行跨度 14.81s 超过窗口上限。设定 7 行以上时**任何**窗口都会包含它，
    // 旧实现直接退回 lines=[]，把一首有 12 句歌词的歌显示成「纯音乐或无歌词」。
    const lines = [
      { time: 15_620, endTime: 23_010, text: "句一" },
      { time: 23_010, endTime: 30_870, text: "句二" },
      { time: 30_870, endTime: 38_240, text: "句三" },
      { time: 38_240, endTime: 45_650, text: "句四" },
      { time: 45_650, endTime: 53_040, text: "句五" },
      { time: 53_040, endTime: 67_850, text: "句六" },
      { time: 67_850, endTime: 75_230, text: "句七" },
      { time: 75_230, endTime: 82_640, text: "句八" },
      { time: 82_640, endTime: 90_020, text: "句九" },
      { time: 90_020, endTime: 93_710, text: "句十" },
      { time: 93_710, endTime: 97_420, text: "句十一" },
      { time: 97_420, endTime: 102_420, text: "句十二" },
    ];

    // 设定 7~10 行时收缩到 6 行，取间奏之后的紧凑段。
    // 提前量 700ms：上一句是行级歌词（没有逐字结束时间戳），按更短的固定提前量留渐入空间。
    for (const configured of [7, 8, 9, 10]) {
      const clip = createSongLyricClip(lines, configured, { nextInt: () => 0 }, 236_007);
      expect(clip.lines).toHaveLength(6);
      expect(clip.lines[0].text).toBe("句七");
      expect(clip.startTime).toBe(67_150);
      expect(clip.endTime).toBe(103_420);
    }

    // 设定行数本身可行时不受影响，仍按设定取满。
    const exact = createSongLyricClip(lines, 5, { nextInt: () => 0 }, 236_007);
    expect(exact.lines).toHaveLength(5);
    expect(exact.lines[0].text).toBe("句一");

    // 收缩下限为 2 行：只有单句歌词时仍判定为不可出题（保持既有语义）。
    const single = createSongLyricClip(lines.slice(0, 1), 5, { nextInt: () => 7_000 }, 180_000);
    expect(single).toEqual({ startTime: 7_000, endTime: 37_000, lines: [] });
  });

  test("跨越超过 6 秒间奏的两句歌词不会被拼入同一个出题窗口", () => {
    // 模拟《一样的月光》：第 2 句与第 3 句之间存在 54 秒超长大间奏
    const linesWithLongInterlude = [
      { time: 126_620, endTime: 130_390, text: "不再殷切 需要" },
      { time: 131_400, endTime: 136_590, text: "太多理智的世界" },
      // 54 秒长间奏
      { time: 190_700, endTime: 194_340, text: "其实看得我越来越心慌" },
      { time: 194_680, endTime: 198_530, text: "怎么你留下最真实的回忆" },
      { time: 198_700, endTime: 202_350, text: "都是提醒我失去的声音" },
    ];

    // 当设定 4 行时，由于跨间奏窗口被拒绝，算法自动收缩到 3 行并在间奏之后取连续段
    const clip = createSongLyricClip(linesWithLongInterlude, 4, { nextInt: () => 0 }, 240_000);
    expect(clip.lines).toHaveLength(3);
    expect(clip.lines[0].text).toBe("其实看得我越来越心慌");
    expect(clip.lines[1].text).toBe("怎么你留下最真实的回忆");
    expect(clip.lines[2].text).toBe("都是提醒我失去的声音");

    // 无论怎么随机挑选窗口，都绝对不会出现跨越间奏的 [太多理智的世界, 其实看得我越来越心慌] 组合
    for (let i = 0; i < 10; i++) {
      const randomClip = createSongLyricClip(
        linesWithLongInterlude,
        2,
        { nextInt: (max) => i % max },
        240_000
      );
      const texts = randomClip.lines.map((l) => l.text);
      const hasCrossInterlude =
        texts.includes("太多理智的世界") && texts.includes("其实看得我越来越心慌");
      expect(hasCrossInterlude).toBe(false);
    }
  });

  test("和声背景歌词（isBG）不会作为出题开头，也不充抵出题行数，播放时完整保留", () => {
    const linesWithBackgroundVocals = [
      { time: 10_000, endTime: 15_000, text: "第一句主歌词" },
      { time: 12_000, endTime: 14_000, text: "和声小字A (Ah~)", isBG: true },
      { time: 16_000, endTime: 20_000, text: "第二句主歌词" },
      { time: 18_000, endTime: 19_500, text: "和声小字B (Yeah~)", isBG: true },
      { time: 21_000, endTime: 25_000, text: "第三句主歌词" },
    ];

    // 设定取 2 行：应该取到两句完整主歌词，而不是主歌词+和声小字
    const clip = createSongLyricClip(linesWithBackgroundVocals, 2, { nextInt: () => 0 }, 180_000);
    // 第一行必定不是和声歌词
    expect(clip.lines[0].text).toBe("第一句主歌词");
    expect(clip.lines[0].isBG).toBeFalsy();

    // 音频结束时间必须能覆盖到第二句主歌词（20000），而不是被第一句中间的和声（14000）提早切断
    expect(clip.endTime).toBeGreaterThanOrEqual(19_750);

    // 包含两句主歌词以及随行的和声歌词供播放时演出
    const texts = clip.lines.map((l) => l.text);
    expect(texts).toContain("第一句主歌词");
    expect(texts).toContain("和声小字A (Ah~)");
    expect(texts).toContain("第二句主歌词");
  });

  test("出题窗口的提前量不越过上一句歌词的结尾", () => {
    const words = (time: number, endTime: number, text: string) => [
      { startTime: time, endTime, word: text },
    ];
    const previous: SongLyricLine = {
      time: 10_000,
      endTime: 19_700,
      text: "上一句",
      words: words(10_000, 19_700, "上一句"),
    };
    const windowLines: SongLyricLine[] = [
      { time: 20_000, endTime: 23_000, text: "题目一", words: words(20_000, 23_000, "题目一") },
      { time: 23_200, endTime: 26_000, text: "题目二", words: words(23_200, 26_000, "题目二") },
    ];
    // 窗口候选为 [上一句, 题目一] 与 [题目一, 题目二]，`nextInt` 取 1 即选中后者
    const clipOf = (prev: SongLyricLine) =>
      createSongLyricClip([prev, ...windowLines], 2, { nextInt: () => 1 }, 60_000);

    // 逐字上一句 19.7s 唱完，只剩 300ms 空隙：提前量收到 300ms，绝不听见上一句
    expect(clipOf(previous).startTime).toBe(19_700);
    // 上一句一直唱到窗口起点：不留提前量
    expect(clipOf({ ...previous, endTime: 20_000 }).startTime).toBe(20_000);
    // 空隙足够长：用满 1 秒渐入缓冲
    expect(clipOf({ ...previous, endTime: 15_000 }).startTime).toBe(19_000);
    // 行级歌词没有逐字结束时间戳（endTime 是清洗时补算的）：退回更短的固定提前量
    const { words: _words, ...lineLevelPrevious } = previous;
    expect(clipOf(lineLevelPrevious).startTime).toBe(19_300);
    // 后延缓冲不受这条规则影响
    expect(clipOf(previous).endTime).toBe(27_000);

    // 窗口就是第一句时前面只有前奏，仍留满 1 秒
    const firstWindow = createSongLyricClip(
      [previous, ...windowLines],
      2,
      { nextInt: () => 0 },
      60_000
    );
    expect(firstWindow.lines[0].text).toBe("上一句");
    expect(firstWindow.startTime).toBe(9_000);

    // 窗口前最近的一句是和声歌词：同样按它的结尾收提前量
    const withLateHarmony = createSongLyricClip(
      [
        {
          time: 19_000,
          endTime: 19_900,
          text: "和声",
          isBG: true,
          words: words(19_000, 19_900, "和声"),
        },
        ...windowLines,
      ],
      2,
      { nextInt: () => 0 },
      60_000
    );
    expect(withLateHarmony.lines[0].text).toBe("题目一");
    expect(withLateHarmony.startTime).toBe(19_900);
  });
});
