import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appVersionPlugin } from "../../vite.config";
import { resolveLatestVersion, type ChangelogEntry } from "./Changelog";
import realChangelog from "../data/changelog.json";

const RESOLVED_ID = "\0virtual:app-version";

/** 把日志原文落成临时文件再喂给插件：插件读的是磁盘路径，与构建期一致。 */
async function emitVersion(changelogText: string) {
  const dir = await mkdtemp(join(tmpdir(), "app-version-"));
  const file = join(dir, "changelog.json");
  await writeFile(file, changelogText, "utf8");
  try {
    return appVersionPlugin(file).load(RESOLVED_ID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("app-version 虚拟模块", () => {
  it("只接管 virtual:app-version", () => {
    const plugin = appVersionPlugin("changelog.json");
    expect(plugin.resolveId(RESOLVED_ID)).toBeNull();
    expect(plugin.resolveId("virtual:app-version")).toBe(RESOLVED_ID);
    expect(plugin.resolveId("virtual:commit-history")).toBeNull();
    expect(plugin.load("./src/pages/LandingPage.tsx")).toBeNull();
  });

  it("取版本号最大的一条，与书写顺序和 package.json 无关", async () => {
    const entries = [{ version: "1.2.0" }, { version: "1.10.0" }, { version: "1.9.9" }];
    expect(await emitVersion(JSON.stringify({ entries }))).toBe('export default "1.10.0"');
  });

  it("没有条目时给空串，页面按既有口径显示占位版本号", async () => {
    expect(await emitVersion(JSON.stringify({ entries: [] }))).toBe('export default ""');
    expect(await emitVersion("{}")).toBe('export default ""');
  });

  it("真实日志下的取值与运行时 helper 同源", async () => {
    const entries = (realChangelog as { entries: ChangelogEntry[] }).entries;
    expect(await emitVersion(JSON.stringify({ entries }))).toBe(
      `export default ${JSON.stringify(resolveLatestVersion(entries))}`
    );
  });

  it("改日志文件才失效虚拟模块，别的文件不动它", () => {
    const invalidated: string[] = [];
    const mod = { id: RESOLVED_ID };
    const server = {
      moduleGraph: {
        getModuleById: (id: string) => (id === RESOLVED_ID ? mod : undefined),
        invalidateModule: (target: typeof mod) => void invalidated.push(target.id),
      },
    };
    const plugin = appVersionPlugin("/repo/src/data/changelog.json");

    plugin.handleHotUpdate({ file: "/repo/src/index.css", server });
    expect(invalidated).toEqual([]);
    plugin.handleHotUpdate({ file: "/repo/src/data/changelog.json", server });
    expect(invalidated).toEqual([RESOLVED_ID]);
  });
});
