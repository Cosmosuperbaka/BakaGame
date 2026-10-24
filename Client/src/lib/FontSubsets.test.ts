import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FAMILIES,
  FONT_RELEASE,
  buildChunkPlan,
  buildFontCss,
  chunkCodepoints,
  collectProjectCjk,
  formatUnicodeRange,
  gb2312Codepoints,
  hashCodepoints,
} from "../../scripts/font-subset-plan.mjs";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("font-subset-plan", () => {
  it("GB2312 覆盖一级与二级常用汉字", () => {
    const codepoints = gb2312Codepoints();
    expect(codepoints.length).toBeGreaterThanOrEqual(6_000);
    expect(codepoints).toContain(0x4e00);
    expect(codepoints).toContain(0x7684);
  });

  it("unicode-range 合并连续码位并去重", () => {
    expect(formatUnicodeRange([0x40, 0x20, 0x21, 0x22, 0x30, 0x31, 0x20])).toBe(
      "U+20-22,U+30-31,U+40"
    );
    expect(formatUnicodeRange([])).toBe("");
  });

  it("按大小切分且不丢字、不重复", () => {
    const codepoints = Array.from({ length: 25 }, (_, index) => 0x4e00 + index);
    const chunks = chunkCodepoints(codepoints, 10);
    expect(chunks.map((chunk) => chunk.length)).toEqual([10, 10, 5]);
    expect(chunks.flat()).toEqual(codepoints);
  });

  it("常用字按词频分片，其余按码位分片", () => {
    const chunks = buildChunkPlan({
      baseCodepoints: [0x20, 0x21],
      extendedCodepoints: [0x4e00, 0x4e01, 0x4e02, 0x4e03],
      frequencyOrder: [0x4e02, 0x4e00],
      chunkSizes: { base: 10, common: 2, rest: 10 },
      commonCodepointCount: 2,
    });
    expect(chunks.map((chunk) => chunk.kind)).toEqual(["base", "common", "rest"]);
    expect(chunks[1].cps).toEqual([0x4e02, 0x4e00]);
    expect(chunks[2].cps).toEqual([0x4e01, 0x4e03]);
    expect(new Set(chunks.flatMap((chunk) => chunk.cps)).size).toBe(6);
  });

  it("完整字符集里的非 CJK 扩展字符也会进入分包", () => {
    const chunks = buildChunkPlan({
      baseCodepoints: [0x20],
      extendedCodepoints: [0x4e00, 0xac00],
      frequencyOrder: [0x4e00],
      chunkSizes: { base: 10, common: 10, rest: 10 },
    });
    expect(chunks.flatMap((chunk) => chunk.cps)).toContain(0xac00);
  });

  it("基础字符与扩展字符重叠时直接报错", () => {
    expect(() =>
      buildChunkPlan({
        baseCodepoints: [0x20, 0x4e00],
        extendedCodepoints: [0x4e00],
      })
    ).toThrow(/重复/);
  });

  it("字体 CSS 只引用 woff2 子集并覆盖三档字重", () => {
    const chunk = { index: 0, kind: "base" as const, cps: [0x20, 0x21] };
    const css = buildFontCss({ sansChunks: [chunk], monoChunks: [chunk] });
    for (const family of FAMILIES) {
      expect(css).toContain(`font-family: "${family.family}"`);
      for (const { weight } of family.weights) {
        expect(css).toContain(`font-weight: ${weight}`);
      }
    }
    expect(css).toContain("font-display: swap");
    expect(css).toContain("unicode-range: U+20-21");
    expect(css).not.toMatch(/\.ttf|\.otf/);
  });

  it("扫描项目用字时跳过依赖目录与非文本文件", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "font-subset-"));
    tempDirs.push(dir);
    await mkdir(path.join(dir, "pages"), { recursive: true });
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await writeFile(path.join(dir, "pages", "A.tsx"), "中文");
    await writeFile(path.join(dir, "node_modules", "B.tsx"), "忽略");
    await writeFile(path.join(dir, "C.bin"), "忽略");
    const codepoints = await collectProjectCjk(dir);
    expect(codepoints).toContain("中".codePointAt(0));
    expect(codepoints).toContain("文".codePointAt(0));
    expect(codepoints).not.toContain("忽".codePointAt(0));
  });

  it("码位哈希与顺序无关", () => {
    expect(hashCodepoints([0x4e00, 0x4e01])).toBe(hashCodepoints([0x4e01, 0x4e00]));
    expect(hashCodepoints([0x4e00])).not.toBe(hashCodepoints([0x4e01]));
  });

  it("上游字体版本与发布摘要固定，覆盖声明的全部字重", () => {
    expect(FONT_RELEASE.version).toBe("1.530");
    const expectedFiles = FAMILIES.flatMap((family) =>
      family.weights.map(({ file }) => file)
    ).sort();
    expect(Object.keys(FONT_RELEASE.files).sort()).toEqual(expectedFiles);
    for (const file of expectedFiles) {
      expect(FONT_RELEASE.files[file].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(FONT_RELEASE.files[file].bytes).toBeGreaterThan(1_000_000);
    }
  });
});
