import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { toSimplified } from "../src/infrastructure/ChineseConverter";

/**
 * 繁简表以「第 i 个字对应第 i 个字」的两条并行字符串存放：插入或删除一个字会让其后全部错位且不报错。
 * 表是模块私有数据，这里直接读源码里的两条字符串做完整性守卫，不为测试暴露内部状态。
 */
const source = readFileSync(
  new URL("../src/infrastructure/ChineseConverter.ts", import.meta.url),
  "utf8"
);
const readTable = (name: string): string[] => {
  const matched = new RegExp(String.raw`const ${name} =\s*"([^"]*)"`).exec(source);
  if (!matched) throw new Error(`找不到 ${name} 表`);
  return [...matched[1]!];
};
const traditional = readTable("TRADITIONAL");
const simplified = readTable("SIMPLIFIED");

describe("繁简转换表完整性", () => {
  test("两条并行字符串等长，且没有恒等映射", () => {
    expect(traditional.length).toBe(simplified.length);
    const identity = traditional.filter((char, index) => char === simplified[index]);
    expect(identity).toEqual([]);
  });

  test("两条字符串逐位对齐：每个繁体字都转成同位置的简体字", () => {
    for (const [index, char] of traditional.entries()) {
      expect(toSimplified(char)).toBe(simplified[index]!);
    }
  });

  test("表内没有重复的繁体键", () => {
    expect(new Set(traditional).size).toBe(traditional.length);
  });

  test("日文新字体按简体归一，普通简体与日文假名原样保留", () => {
    expect(toSimplified("楽園の気持ち")).toBe("乐园の气持ち");
    expect(toSimplified("声学国会恋")).toBe("声学国会恋");
    expect(toSimplified("ひらがなカタカナ")).toBe("ひらがなカタカナ");
  });
});
