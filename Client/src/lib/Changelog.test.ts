import { describe, expect, it } from "vitest";

import {
  compareVersions,
  parseChangelogContent,
  resolveLatestVersion,
  sortEntriesByVersion,
  type ChangelogEntry,
} from "./Changelog";

const entry = (version: string): ChangelogEntry => ({
  version,
  date: "2026-08-08",
  content: version,
});

describe("changelog helpers", () => {
  it("compares numeric version segments instead of lexicographic text", () => {
    expect(compareVersions("v1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(resolveLatestVersion([entry("1.9.9"), entry("1.10.0")])).toBe("1.10.0");
  });

  it("sorts a copy without mutating the source entries", () => {
    const source = [entry("1.0.0"), entry("2.0.0"), entry("1.5.0")];

    expect(sortEntriesByVersion(source).map(({ version }) => version)).toEqual([
      "2.0.0",
      "1.5.0",
      "1.0.0",
    ]);
    expect(source.map(({ version }) => version)).toEqual(["1.0.0", "2.0.0", "1.5.0"]);
  });

  it("parses list and inline markup while degrading unsafe links to text", () => {
    const blocks = parseChangelogContent([
      "- **修复** `重连`",
      "- [文档](https://example.com)",
      "",
      "[危险链接](javascript:alert)",
    ]);

    expect(blocks).toEqual([
      {
        kind: "list",
        items: [
          [
            { kind: "strong", text: "修复" },
            { kind: "text", text: " " },
            { kind: "code", text: "重连" },
          ],
          [{ kind: "link", text: "文档", href: "https://example.com" }],
        ],
      },
      {
        kind: "paragraph",
        content: [{ kind: "text", text: "危险链接" }],
      },
    ]);
  });
});
