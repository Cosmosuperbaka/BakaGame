import { describe, expect, it } from "vitest";
import {
  COMMIT_HISTORY_LIMIT,
  commitsApiUrl,
  mapGitHubCommits,
  normalizeCommitEntries,
  repositorySlug,
} from "./CommitHistory";

const REPOSITORY = "https://github.com/Cosmosuperbaka/BakaGame";

describe("repositorySlug", () => {
  it("extracts owner and repo from a github https url", () => {
    expect(repositorySlug(REPOSITORY)).toBe("Cosmosuperbaka/BakaGame");
  });

  it("tolerates trailing slash and .git suffix", () => {
    expect(repositorySlug(`${REPOSITORY}/`)).toBe("Cosmosuperbaka/BakaGame");
    expect(repositorySlug(`${REPOSITORY}.git`)).toBe("Cosmosuperbaka/BakaGame");
  });

  it("returns null for a non-github url", () => {
    expect(repositorySlug("https://gitlab.com/Cosmosuperbaka/BakaGame")).toBeNull();
    expect(repositorySlug("https://github.com/Cosmosuperbaka")).toBeNull();
    expect(repositorySlug("")).toBeNull();
  });
});

describe("commitsApiUrl", () => {
  it("pins the list to the given revision and caps the page size", () => {
    const url = commitsApiUrl(REPOSITORY, "a".repeat(40));

    expect(url).toContain("https://api.github.com/repos/Cosmosuperbaka/BakaGame/commits");
    expect(url).toContain(`sha=${"a".repeat(40)}`);
    expect(url).toContain(`per_page=${COMMIT_HISTORY_LIMIT}`);
  });

  it("respects a custom limit", () => {
    expect(commitsApiUrl(REPOSITORY, "abc1234", 5)).toContain("per_page=5");
  });

  it("returns null when the repository or revision is unusable", () => {
    expect(commitsApiUrl("https://example.com/repo", "abc1234")).toBeNull();
    expect(commitsApiUrl(REPOSITORY, "   ")).toBeNull();
  });
});

describe("normalizeCommitEntries", () => {
  it("shortens the hash and normalizes the date to iso utc", () => {
    const entries = normalizeCommitEntries([
      { hash: "0123456789abcdef", message: "feat(CCB): 队伍面板", date: "2026-10-06T09:20:30+08:00", author: "Cosmosuperbaka" },
    ]);

    expect(entries).toEqual([
      {
        hash: "0123456",
        message: "feat(CCB): 队伍面板",
        date: "2026-10-06T01:20:30.000Z",
        author: "Cosmosuperbaka",
      },
    ]);
  });

  it("keeps only the subject line of a multi-line message", () => {
    const entries = normalizeCommitEntries([
      { hash: "0123456789abcdef", message: "fix(Song): 修音量条\n\n详细正文\n第二段", date: "2026-10-06T01:00:00Z", author: "a" },
    ]);

    expect(entries[0]?.message).toBe("fix(Song): 修音量条");
  });

  it("drops entries missing hash, subject or a parsable date", () => {
    const entries = normalizeCommitEntries([
      { hash: "0123456789abcdef", message: "无日期", author: "a" },
      { hash: "0123456789abcdef", message: "", date: "2026-10-06T01:00:00Z", author: "a" },
      { hash: "abc", message: "哈希过短", date: "2026-10-06T01:00:00Z", author: "a" },
      { hash: "0123456789abcdef", message: "日期不可解析", date: "不是时间", author: "a" },
      { hash: "0123456789abcdef", message: "唯一有效", date: "2026-10-06T01:00:00Z", author: "a" },
    ]);

    expect(entries.map((entry) => entry.message)).toEqual(["唯一有效"]);
  });

  it("falls back to a placeholder author instead of dropping the entry", () => {
    const entries = normalizeCommitEntries([
      { hash: "0123456789abcdef", message: "缺作者", date: "2026-10-06T01:00:00Z" },
      { hash: "0123456789abcdef", message: "作者空白", date: "2026-10-06T01:00:00Z", author: "   " },
    ]);

    expect(entries.map((entry) => entry.author)).toEqual(["未知作者", "未知作者"]);
  });

  it("caps the number of entries", () => {
    const raw = Array.from({ length: 10 }, (_, index) => ({
      hash: `0123456789abcdef${index}`,
      message: `第 ${index} 条`,
      date: "2026-10-06T01:00:00Z",
      author: "a",
    }));

    expect(normalizeCommitEntries(raw, 3)).toHaveLength(3);
    expect(normalizeCommitEntries(raw)).toHaveLength(10);
  });

  it("returns an empty list for non-array input", () => {
    expect(normalizeCommitEntries(null)).toEqual([]);
    expect(normalizeCommitEntries({ commits: [] })).toEqual([]);
    expect(normalizeCommitEntries([null, 42, "x"])).toEqual([]);
  });
});

describe("mapGitHubCommits", () => {
  const payload = [
    {
      sha: "0123456789abcdef0123456789abcdef01234567",
      commit: {
        message: "feat(CCB): 队伍面板与分队玩家栏\n\n正文不该进时间线",
        author: { name: "Cosmosuperbaka", email: "someone@example.com", date: "2026-10-06T01:20:30Z" },
      },
      author: { login: "Cosmosuperbaka" },
      html_url: "https://github.com/Cosmosuperbaka/BakaGame/commit/0123456",
    },
    {
      sha: "abcdef0123456789abcdef0123456789abcdef01",
      commit: {
        message: "chore(Core): 更新番剧数据",
        author: { name: "github-actions[bot]", date: "2026-10-04T23:55:21Z" },
      },
      author: null,
    },
  ];

  it("maps the fields the timeline needs", () => {
    expect(mapGitHubCommits(payload)).toEqual([
      {
        hash: "0123456",
        message: "feat(CCB): 队伍面板与分队玩家栏",
        date: "2026-10-06T01:20:30.000Z",
        author: "Cosmosuperbaka",
      },
      {
        hash: "abcdef0",
        message: "chore(Core): 更新番剧数据",
        date: "2026-10-04T23:55:21.000Z",
        author: "github-actions[bot]",
      },
    ]);
  });

  it("never lets the author email reach the bundle", () => {
    const serialized = JSON.stringify(mapGitHubCommits(payload));

    expect(serialized).not.toContain("someone@example.com");
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("html_url");
  });

  it("skips malformed records", () => {
    const entries = mapGitHubCommits([
      { commit: { message: "缺 sha", author: { name: "a", date: "2026-10-06T01:00:00Z" } } },
      { sha: "0123456789abcdef", commit: null },
      { sha: "0123456789abcdef", commit: { message: "作者缺失", author: null } },
      null,
    ]);

    expect(entries).toEqual([]);
  });

  it("returns an empty list when github answers with an error object", () => {
    expect(mapGitHubCommits({ message: "API rate limit exceeded" })).toEqual([]);
    expect(mapGitHubCommits(undefined)).toEqual([]);
  });

  it("caps the number of entries", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      sha: `${String(index).padStart(8, "0")}abcdef0123456789abcdef01234567`,
      commit: { message: `第 ${index} 条`, author: { name: "a", date: "2026-10-06T01:00:00Z" } },
    }));

    expect(mapGitHubCommits(many)).toHaveLength(COMMIT_HISTORY_LIMIT);
  });
});
