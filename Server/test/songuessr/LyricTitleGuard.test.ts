import { describe, expect, test } from "bun:test";
import { createSongLyricClip } from "../../src/application/songuessr/LyricClip";
import {
  countTitleLines,
  prepareTitleNames,
  songTitleNames,
} from "../../src/application/songuessr/LyricTitleGuard";
import type { SongLyricLine } from "../../src/shared/SonGuessr";

/** 每行 3 秒、首尾相接的歌词。 */
const lyricsOf = (
  texts: string[],
  extra: (index: number) => Partial<SongLyricLine> = () => ({})
): SongLyricLine[] =>
  texts.map((text, index) => ({
    time: index * 3_000,
    endTime: (index + 1) * 3_000,
    text,
    ...extra(index),
  }));

/** 遍历随机源的每个取值，收集所有可能被选中的片段。 */
const allPossibleClips = (
  lyrics: SongLyricLine[],
  lineCount: number,
  titleNames: string[] | undefined,
  samples = 40
) =>
  Array.from({ length: samples }, (_, pick) =>
    createSongLyricClip(lyrics, lineCount, { nextInt: (max) => pick % max }, 600_000, titleNames)
  );

const clipText = (lines: SongLyricLine[]) => lines.map((line) => line.text).join("|");

describe("随机区间回避歌名", () => {
  const filler = (count: number, prefix = "路上的风景") =>
    Array.from({ length: count }, (_, index) => `${prefix}${index}`);

  test("存在干净区间时，任何随机取值都不会选中含歌名的区间", () => {
    const lyrics = lyricsOf([
      ...filler(6),
      "星河长明",
      "我唱起星河长明的旋律",
      ...filler(6, "远方的灯火"),
    ]);
    const clips = allPossibleClips(lyrics, 3, ["星河长明"]);
    for (const clip of clips) {
      expect(clip.lines).toHaveLength(3);
      expect(clipText(clip.lines)).not.toContain("星河长明");
    }
    // 对照：不传歌名时同样的随机取值会选中含歌名的区间，说明用例有判别力。
    const unguarded = allPossibleClips(lyrics, 3, undefined);
    expect(unguarded.some((clip) => clipText(clip.lines).includes("星河长明"))).toBe(true);
  });

  test("歌名只在副歌出现时，随机区间全部落在非副歌段", () => {
    const verse = filler(8, "主歌");
    const chorus = ["副歌里唱着夏日终章", "夏日终章夏日终章", "把夏日终章唱给你听"];
    const lyrics = lyricsOf([...verse, ...chorus, ...filler(8, "桥段")]);
    for (const clip of allPossibleClips(lyrics, 4, ["夏日终章"])) {
      expect(clipText(clip.lines)).not.toContain("夏日终章");
    }
  });

  test("设定行数下没有干净区间，但收缩后有时，宁可收缩也不含歌名", () => {
    // 每隔两行就唱一次歌名：连续 3 行必含歌名，连续 2 行总有干净的。
    const texts = Array.from({ length: 18 }, (_, index) =>
      index % 3 === 0 ? `Starlight 第${index}遍` : `其他歌词${index}`
    );
    const lyrics = lyricsOf(texts);
    for (const clip of allPossibleClips(lyrics, 3, ["Starlight"])) {
      expect(clip.lines).toHaveLength(2);
      expect(clipText(clip.lines).toLowerCase()).not.toContain("starlight");
    }
  });

  test("全曲都含歌名、收缩也无干净区间时才回退，且仍满足行数与连续性", () => {
    const lyrics = lyricsOf(Array.from({ length: 10 }, (_, index) => `第${index}句 夜曲 夜曲`));
    const clips = allPossibleClips(lyrics, 4, ["夜曲"]);
    for (const clip of clips) {
      expect(clip.lines).toHaveLength(4);
      expect(clip.endTime).toBeGreaterThan(clip.startTime);
      for (let index = 1; index < clip.lines.length; index += 1) {
        expect(clip.lines[index].time).toBe(clip.lines[index - 1].endTime);
      }
    }
  });

  test("回退时挑唱出歌名行数最少的区间", () => {
    // 每个 4 行窗口都含歌名，但中段的窗口只含 1 行，其余至少 2 行。
    const texts = [
      "夜曲 A",
      "夜曲 B",
      "夜曲 C",
      "夜曲 D",
      "平淡一",
      "夜曲 E",
      "平淡二",
      "平淡三",
      "夜曲 F",
      "夜曲 G",
      "夜曲 H",
      "夜曲 I",
    ];
    const lyrics = lyricsOf(texts);
    const clips = allPossibleClips(lyrics, 2, ["夜曲"], 20);
    // 2 行窗口里存在不含歌名的（平淡一/平淡二 之间不连成干净对，但 平淡二+平淡三 干净）
    for (const clip of clips) {
      expect(clipText(clip.lines)).not.toContain("夜曲");
    }
    const forced = lyricsOf(["夜曲 一", "夜曲 二", "夜曲 三", "平淡", "夜曲 四", "夜曲 五"]);
    for (const clip of allPossibleClips(forced, 3, ["夜曲"], 12)) {
      const hits = clip.lines.filter((line) => line.text.includes("夜曲")).length;
      // 最少命中的 3 行窗口是「夜曲三/平淡/夜曲四」，命中 2 行；其余窗口命中 ≥2，不会出现 3。
      expect(hits).toBeLessThanOrEqual(2);
    }
  });

  test("歌名写法归一化：大小写、全半角、空格与标点不影响判定", () => {
    const names = prepareTitleNames(songTitleNames({ title: "Hello World" }));
    const hit = (text: string) => countTitleLines(lyricsOf([text]), names);
    expect(hit("HELLO，world")).toBe(1);
    expect(hit("ｈｅｌｌｏ　ｗｏｒｌｄ")).toBe(1);
    expect(hit("say hello-world now")).toBe(1);
    expect(hit("hello there, brave new world")).toBe(0);
  });

  test("繁简与日文假名全半角同样归一", () => {
    const names = prepareTitleNames(songTitleNames({ title: "夜空中最亮的星" }));
    expect(countTitleLines(lyricsOf(["夜空中最亮的星，请照亮我前行"]), names)).toBe(1);
    expect(countTitleLines(lyricsOf(["夜空中最亮的星"]), names)).toBe(1);
    const kana = prepareTitleNames(songTitleNames({ title: "ブルーバード" }));
    expect(countTitleLines(lyricsOf(["ﾌﾞﾙｰﾊﾞｰﾄﾞ 飛んでいけ"]), kana)).toBe(1);
  });

  test("歌名很短时只认整行就是歌名：单字、两个字母不因子串误伤整首歌", () => {
    const one = prepareTitleNames(songTitleNames({ title: "爱" }));
    expect(countTitleLines(lyricsOf(["我爱你到永远"]), one)).toBe(0);
    expect(countTitleLines(lyricsOf(["爱"]), one)).toBe(1);
    expect(countTitleLines(lyricsOf(["爱！"]), one)).toBe(1);
    const latin = prepareTitleNames(songTitleNames({ title: "Go" }));
    expect(countTitleLines(lyricsOf(["let me go now"]), latin)).toBe(0);
    expect(countTitleLines(lyricsOf(["GO"]), latin)).toBe(1);
    // 短歌名整曲都是子串时不应把所有区间判脏：仍能选出区间。
    const lyrics = lyricsOf(Array.from({ length: 10 }, (_, index) => `我爱你${index}`));
    const clip = createSongLyricClip(lyrics, 3, { nextInt: () => 0 }, 600_000, ["爱"]);
    expect(clip.lines).toHaveLength(3);
  });

  test("两个汉字的歌名（晴天、夜曲）仍按子串判定", () => {
    const two = prepareTitleNames(songTitleNames({ title: "夜曲" }));
    expect(countTitleLines(lyricsOf(["一首夜曲的时间"]), two)).toBe(1);
    expect(countTitleLines(lyricsOf(["夜里的曲子"]), two)).toBe(0);
  });

  test("拉丁字母歌名按整词匹配：Love 不误伤 glove / lovely", () => {
    const names = prepareTitleNames(songTitleNames({ title: "Love" }));
    expect(countTitleLines(lyricsOf(["my glove is lovely"]), names)).toBe(0);
    expect(countTitleLines(lyricsOf(["I love you"]), names)).toBe(1);
  });

  test("版本后缀不算歌名：Live、TV Size 去掉后以核心名判定", () => {
    expect(songTitleNames({ title: "晴天 (Live)" })).toContain("晴天");
    expect(songTitleNames({ title: "Butterfly - TV Size" })).toContain("Butterfly");
    const names = prepareTitleNames(songTitleNames({ title: "晴天 (Live)" }));
    expect(countTitleLines(lyricsOf(["故事的小黄花，晴天"]), names)).toBe(1);
    // 后缀本身不当歌名：歌词里的 live 不触发。
    expect(countTitleLines(lyricsOf(["we live for tonight"]), names)).toBe(0);
  });

  test("括号里的译名与百科别名同样回避", () => {
    const bracket = prepareTitleNames(songTitleNames({ title: "ブルーバード (青鸟)" }));
    expect(countTitleLines(lyricsOf(["飞向天空的青鸟"]), bracket)).toBe(1);
    expect(countTitleLines(lyricsOf(["ブルーバード 飛んでいけ"]), bracket)).toBe(1);
    const aliased = prepareTitleNames(
      songTitleNames({ title: "Aozora", encyclopedia: { aliases: ["蓝天"] } })
    );
    expect(countTitleLines(lyricsOf(["看那片蓝天"]), aliased)).toBe(1);
  });

  test("翻译歌词和罗马音里出现歌名也算含歌名", () => {
    const names = prepareTitleNames(songTitleNames({ title: "青鸟" }));
    expect(
      countTitleLines(
        lyricsOf(["原文并不含"], () => ({ translatedLyric: "飞向天空的青鸟" })),
        names
      )
    ).toBe(1);
    const roman = prepareTitleNames(songTitleNames({ title: "Aoi Tori" }));
    expect(
      countTitleLines(
        lyricsOf(["青い鳥"], () => ({ romanLyric: "aoi tori" })),
        roman
      )
    ).toBe(1);
  });

  test("歌名被换行拆开时按跨行拼接判定", () => {
    const names = prepareTitleNames(songTitleNames({ title: "星河长明" }));
    expect(countTitleLines(lyricsOf(["夜里只有星河", "长明不灭"]), names)).toBe(1);
    expect(countTitleLines(lyricsOf(["夜里只有星河", "月亮不灭"]), names)).toBe(0);
  });

  test("回避歌名不放宽既有约束：长间奏仍不能被拼进窗口", () => {
    const lyrics: SongLyricLine[] = [
      { time: 0, endTime: 3_000, text: "第一句" },
      { time: 3_000, endTime: 6_000, text: "第二句" },
      // 30 秒间奏之后的两句，歌名所在的窗口被迫回退
      { time: 36_000, endTime: 39_000, text: "第三句 夜曲" },
      { time: 39_000, endTime: 42_000, text: "第四句" },
    ];
    for (const clip of allPossibleClips(lyrics, 4, ["夜曲"], 8)) {
      // 4 行与 3 行都跨越间奏不可行，收缩到 2 行；干净的只有第一对。
      expect(clip.lines).toHaveLength(2);
      expect(clipText(clip.lines)).toBe("第一句|第二句");
    }
  });

  test("不传歌名时与原有行为完全一致", () => {
    const lyrics = lyricsOf(filler10());
    const a = createSongLyricClip(lyrics, 3, { nextInt: () => 2 }, 600_000);
    const b = createSongLyricClip(lyrics, 3, { nextInt: () => 2 }, 600_000, []);
    expect(b).toEqual(a);
  });
});

function filler10(): string[] {
  return Array.from({ length: 10 }, (_, index) => `词${index}`);
}
