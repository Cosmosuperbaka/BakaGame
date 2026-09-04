import { describe, expect, it } from "vitest";

import {
  compareVersions,
  parseChangelogContent,
  parseChangelogEntry,
  resolveLatestVersion,
  sortEntriesByVersion,
  type ChangelogEntry,
} from "./Changelog";

const entry = (version: string): ChangelogEntry => ({
  version,
  date: "2026-08-08",
  content: { feat: version },
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

  it("parses structured changelog entries and filters out absent or empty categories", () => {
    const sections = parseChangelogEntry({
      fix: ["修复断线重连问题"],
      chore: [],
      docs: "   ",
      feat: ["新增房间观战模式", "支持表情包快捷发送"],
    });

    // chore 和 docs 为空，不应该出现在 sections 中
    expect(sections.map((s) => s.type)).toEqual(["feat", "fix"]);
    expect(sections.map((s) => s.label)).toEqual(["新功能", "问题修复"]);

    expect(sections[0].blocks).toHaveLength(2);
    expect(sections[0].blocks[0]).toEqual({
      kind: "paragraph",
      content: [{ kind: "text", text: "新增房间观战模式" }],
    });
    expect(sections[1].blocks).toHaveLength(1);
    expect(sections[1].blocks[0]).toEqual({
      kind: "paragraph",
      content: [{ kind: "text", text: "修复断线重连问题" }],
    });
  });

  it("sorts categories according to standard semantic order", () => {
    const sections = parseChangelogEntry({
      chore: "升级依赖包",
      fix: "修复已知缺陷",
      perf: "优化网络封包",
      feat: "上线全新玩法",
      custom: "自定义拓展条目",
    });

    expect(sections.map((s) => s.type)).toEqual(["feat", "fix", "perf", "chore", "custom"]);
    expect(sections.find((s) => s.type === "custom")?.label).toBe("custom");
  });
});

