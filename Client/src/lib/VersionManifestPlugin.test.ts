import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { versionManifestPlugin } from "../../scripts/vite-plugins/VersionManifest";
import { resolveLatestVersion, type ChangelogEntry } from "./Changelog";
import realChangelog from "../data/changelog.json";

/** 把日志原文落成临时文件，跑一次构建期产出，取回发出去的文件 */
async function emitManifest(changelogText: string, execGit: (args: string) => string) {
  const dir = await mkdtemp(join(tmpdir(), "version-manifest-"));
  const file = join(dir, "changelog.json");
  await writeFile(file, changelogText, "utf8");
  try {
    const emitted: Array<{ fileName: string; source: string }> = [];
    versionManifestPlugin(file, { execGit }).generateBundle.call({
      emitFile: (asset) => void emitted.push(asset),
    });
    return emitted;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const HEAD = "eb11009a3f5c2d8e1b0f9a7c6d5e4f3a2b1c0d9e";

describe("站点根下的版本清单", () => {
  it("构建期在站点根发出 version.json：产品版本与 7 位提交号，与首页显示同源", async () => {
    const entries = (realChangelog as { entries: ChangelogEntry[] }).entries;
    const emitted = await emitManifest(JSON.stringify({ entries }), () => HEAD);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].fileName).toBe("version.json");
    expect(JSON.parse(emitted[0].source)).toEqual({
      version: resolveLatestVersion(entries),
      commit: "eb11009",
    });
  });

  it("日志为空给空串、不是 git 工作区给 dev，与首页的占位口径一致", async () => {
    const emitted = await emitManifest(JSON.stringify({ entries: [] }), () => {
      throw new Error("not a git repository");
    });
    expect(JSON.parse(emitted[0].source)).toEqual({ version: "", commit: "dev" });
  });

  it("开发服务器同样提供这份清单，且不让浏览器长缓存", async () => {
    const dir = await mkdtemp(join(tmpdir(), "version-manifest-dev-"));
    const file = join(dir, "changelog.json");
    await writeFile(file, JSON.stringify({ entries: [{ version: "1.2.3" }] }), "utf8");
    try {
      let route = "";
      let handler: ((req: unknown, res: never) => void) | undefined;
      versionManifestPlugin(file, { execGit: () => HEAD }).configureServer({
        middlewares: {
          use: (path, fn) => {
            route = path;
            handler = fn as typeof handler;
          },
        },
      });
      const headers: Record<string, string> = {};
      let body = "";
      handler?.({}, {
        setHeader: (name: string, value: string) => void (headers[name] = value),
        end: (text: string) => void (body = text),
      } as never);
      expect(route).toBe("/version.json");
      expect(headers["Cache-Control"]).toBe("no-cache");
      expect(JSON.parse(body)).toEqual({ version: "1.2.3", commit: "eb11009" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
