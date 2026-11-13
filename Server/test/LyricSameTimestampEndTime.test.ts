import { describe, expect, it } from "bun:test";
import { createSongLyricClip } from "../src/application/songuessr/LyricClip";
import { sanitizeLyrics } from "../src/infrastructure/music/lyrics/LyricSanitizer";
import { parseLrc } from "../src/infrastructure/music/netease/NeteaseLyricParse";
import type { SongLyricLine } from "../src/shared/Index";

const song = { title: "测试曲", artist: "歌手", album: "专辑" };
const random = { nextInt: () => 0, nextFloat: () => 0 } as never;
const stamp = (seconds: number) => `[00:${String(seconds).padStart(2, "0")}.00]`;

const bilingualLrc = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const t = stamp(10 + i * 4);
    return `${t}Line number ${i + 1} original\n${t}第${i + 1}句译文内容`;
  }).join("\n");

const clean = (lrc: string) => sanitizeLyrics(parseLrc(lrc), song);
const ends = (lines: SongLyricLine[]) => lines.map((l) => l.endTime);

describe("行级歌词清洗：同起点的行共享结束时刻", () => {
  it("原文加译文同起点：两行结束时刻相同，都等于下一个更晚的起点", () => {
    const lines = clean(
      `${stamp(10)}Original one\n${stamp(10)}译文一\n${stamp(14)}Original two\n${stamp(14)}译文二`
    );
    expect(ends(lines).slice(0, 2)).toEqual([14_000, 14_000]);
  });

  it("三行同起点同理", () => {
    const lines = clean(
      `${stamp(10)}Original one\n${stamp(10)}译文一\n${stamp(10)}罗马音一\n${stamp(15)}Original two`
    );
    expect(ends(lines).slice(0, 3)).toEqual([15_000, 15_000, 15_000]);
  });

  it("末尾一组同起点行沿用末行规则", () => {
    const lines = clean(`${stamp(10)}Original one\n${stamp(14)}Original two\n${stamp(14)}译文二`);
    expect(ends(lines)).toEqual([14_000, 19_000, 19_000]);
  });

  it("单语歌词的结束时刻与修前一致：下一行起点，末行加 5 秒", () => {
    const lines = clean(
      Array.from({ length: 5 }, (_, i) => `${stamp(10 + i * 4)}第${i + 1}句歌词内容`).join("\n")
    );
    expect(ends(lines)).toEqual([14_000, 18_000, 22_000, 26_000, 31_000]);
  });

  it("逐字行保留原始结束时刻，不受影响", () => {
    const word = { startTime: 10_000, endTime: 11_200, word: "逐字" };
    const lines = sanitizeLyrics(
      [
        { time: 10_000, endTime: 11_200, text: "逐字歌词内容", words: [word] },
        { time: 10_000, endTime: 10_000, text: "同起点译文行" },
        {
          time: 20_000,
          endTime: 22_000,
          text: "后一句歌词内容",
          words: [{ ...word, startTime: 20_000, endTime: 22_000 }],
        },
      ],
      song
    );
    expect(ends(lines)).toEqual([11_200, 20_000, 22_000]);
  });
});

describe("出题切片：同时间戳双语歌词", () => {
  it("8 句双语歌词能选出可用窗口，原文与译文成对出现", () => {
    const lines = clean(bilingualLrc(8));
    const clip = createSongLyricClip(lines, 2, random, 240_000);
    expect(clip.lines.length).toBeGreaterThan(0);
    const byTime = new Map<number, number>();
    for (const line of clip.lines) byTime.set(line.time, (byTime.get(line.time) ?? 0) + 1);
    for (const count of byTime.values()) expect(count).toBe(2);
  });

  it("单语对照歌词选出的窗口与修前相同", () => {
    const lrc = Array.from(
      { length: 8 },
      (_, i) => `${stamp(10 + i * 4)}第${i + 1}句歌词内容`
    ).join("\n");
    const clip = createSongLyricClip(clean(lrc), 2, random, 240_000);
    expect(clip.lines.map((l) => l.text)).toEqual(["第3句歌词内容", "第4句歌词内容"]);
  });
});
