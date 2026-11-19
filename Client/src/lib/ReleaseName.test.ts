import { describe, expect, it } from "vitest";
import { gitRevision } from "../../scripts/vite-plugins/GitRevision.ts";
import { sentryReleaseName } from "../../scripts/vite-plugins/SentrySourcemaps.ts";
import { formatReleaseName, shortCommit } from "./ReleaseName";

describe("发布名口径", () => {
  it("提交号固定截 7 位，版本缺失按 0.0.0", () => {
    expect(shortCommit("0123456789abcdef")).toBe("0123456");
    expect(formatReleaseName("1.12.0", "0123456789abcdef")).toBe("V1.12.0（0123456）");
    expect(formatReleaseName("", "abcdef0123")).toBe("V0.0.0（abcdef0）");
  });

  it("构建期创建的 release 与运行时上报的 release 逐字相同", () => {
    // 两边共用同一个格式化函数：改括号、前缀或位数只会同时改两边。
    const revision = "89abcdef01234567";
    const fromPlugin = sentryReleaseName("src/data/changelog.json", revision);
    const version = fromPlugin?.match(/^V(.+)（/)?.[1] ?? "";
    expect(fromPlugin).toBe(formatReleaseName(version, shortCommit(revision)));
  });

  it("取不到 git 时返回空串，不抛错", () => {
    expect(
      gitRevision(() => {
        throw new Error("not a git repository");
      })
    ).toBe("");
    expect(gitRevision(() => "abc123")).toBe("abc123");
  });
});
