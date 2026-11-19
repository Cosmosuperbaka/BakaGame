import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** 玩法组件的文件前缀约定（Agents/Conventions.md §1.2）：裸名会让三款游戏的同名组件分不清。 */
const GAME_PREFIXES = { whoisfaker: "Faker", songuessr: "Song", cee: "CEE" } as const;

const filesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });

describe("玩法组件命名", () => {
  it.each(Object.entries(GAME_PREFIXES))("%s 目录下的文件都带 %s 前缀", (dir, prefix) => {
    const root = path.join(import.meta.dirname, dir);
    const bare = filesUnder(root)
      .map((file) => path.basename(file))
      .filter((name) => /\.(tsx?)$/.test(name))
      .filter((name) => !name.startsWith(prefix) && !name.startsWith(`Use${prefix}`));
    expect(bare).toEqual([]);
  });
});
