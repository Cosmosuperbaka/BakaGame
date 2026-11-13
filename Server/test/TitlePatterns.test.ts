import { describe, expect, test } from "bun:test";
import { stripVersionInfo } from "../src/domain/TitlePatterns";

describe("stripVersionInfo", () => {
  test("剥掉括号里的版本说明与尾部装饰后缀，保留正常括号", () => {
    expect(stripVersionInfo("曲名 (TV Size)")).toBe("曲名");
    expect(stripVersionInfo("曲名（伴奏）")).toBe("曲名");
    expect(stripVersionInfo("曲名 - Instrumental -")).toBe("曲名");
    expect(stripVersionInfo("曲名 (心跳)")).toBe("曲名 (心跳)");
  });

  test("多层标记循环剥到稳定", () => {
    expect(stripVersionInfo("曲名 (Live) (feat. 某人)")).toBe("曲名");
    expect(stripVersionInfo("曲名 [Remix] (TV Size)")).toBe("曲名");
  });

  test("没有版本标记的曲名原样返回", () => {
    expect(stripVersionInfo("残酷な天使のテーゼ")).toBe("残酷な天使のテーゼ");
  });
});
