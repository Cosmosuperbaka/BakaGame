import { describe, expect, test } from "bun:test";
import { isCreditLyricLine, sanitizeLyrics } from "../src/infrastructure/music/lyrics/LyricLines";

/** 用互不相同的 12 个中文字拼头部，避免命中任何已登记标签。 */
const POOL = "我们走过岁月随风而去你还记得吗山海云天星河长路梦醒时分";
const head = (offset: number) => [...POOL].slice(offset, offset + 12).join("");

describe("歌词署名判定：中文长头部不得指数级放大", () => {
  test("12 字头部的空格形态与冒号形态仍判为普通歌词", () => {
    const text = `${head(0)} 你还记得吗`;
    expect(isCreditLyricLine(text)).toBe(false);
    expect(isCreditLyricLine(`${head(1)}：你还记得吗`)).toBe(false);
  });

  test("整首歌都是 12 字头部加空格的长句，清洗仍在很短时间内完成且一行不丢", () => {
    const lines = Array.from({ length: 120 }, (_, index) => ({
      time: index * 3_000,
      endTime: index * 3_000 + 2_500,
      text: `${head(index % 14)} 你还记得吗`,
    }));

    const startedAt = performance.now();
    const cleaned = sanitizeLyrics(lines, { title: "测试曲", artist: "测试者" });
    const elapsed = performance.now() - startedAt;

    expect(cleaned).toHaveLength(lines.length);
    // 指数递归下每次判定约 20ms、每行最多三次，这个量级需要数秒；
    // 取 2 秒是给慢机器留足余量，仍能稳定区分多项式与指数。
    expect(elapsed).toBeLessThan(2_000);
  });
});
