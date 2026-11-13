import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OUTPUT_MARKER,
  OUTPUT_PREFIX,
  assertSafeOutputDir,
} from "../../scripts/output-dir-guard.mjs";

describe("截图脚本的输出目录护栏", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "output-dir-guard-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("拒绝工作区自身、祖先与越界路径", () => {
    for (const target of [".", "", "..", "../sibling", "a/../.."])
      expect(() => assertSafeOutputDir(root, target)).toThrow(/内部的子目录/);
  });

  it("拒绝已存在、名字不对且没有标记文件的目录（例如源码目录）", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "App.tsx"), "export {}");
    expect(() => assertSafeOutputDir(root, "src")).toThrow(/拒绝清空/);
  });

  it("放行约定前缀的目录、带标记文件的目录与尚不存在的目录", async () => {
    await mkdir(join(root, `${OUTPUT_PREFIX}-ab`));
    await mkdir(join(root, "custom"));
    await writeFile(join(root, "custom", OUTPUT_MARKER), "");
    expect(assertSafeOutputDir(root, `${OUTPUT_PREFIX}-ab`)).toBe(join(root, `${OUTPUT_PREFIX}-ab`));
    expect(assertSafeOutputDir(root, "custom")).toBe(join(root, "custom"));
    expect(assertSafeOutputDir(root, "fresh")).toBe(join(root, "fresh"));
  });
});
