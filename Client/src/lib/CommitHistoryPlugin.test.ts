import { afterEach, describe, expect, it, vi } from "vitest";
import { commitHistoryPlugin } from "../../vite.config";

const RESOLVED_ID = "\0virtual:commit-history";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

const GITHUB_PAYLOAD = [
  {
    sha: HEAD_SHA,
    commit: {
      message: "feat(CCB): 队伍面板与分队玩家栏\n\n正文不该进时间线",
      author: { name: "Cosmosuperbaka", email: "someone@example.com", date: "2026-10-06T01:20:30Z" },
    },
    author: { login: "Cosmosuperbaka" },
  },
];

/** 复刻 git log 的输出：\x00 分字段、\x1F 分记录，日期为带时区的 iso-strict。 */
const GIT_LOG_RAW = [
  `${HEAD_SHA}\x00feat(Song): 音量条改为胶囊并可静音\x002026-10-06T09:35:18+08:00\x00Cosmosuperbaka\x1F`,
  `abcdef0123456789abcdef0123456789abcdef01\x00chore(Core): 更新番剧数据\x002026-10-04T23:55:21+00:00\x00github-actions[bot]\x1F`,
].join("");

/** 桩 git：测试跑不了子进程，用固定输出替代真实仓库状态。 */
function fakeGit(args: string) {
  if (args === "rev-parse HEAD") return HEAD_SHA;
  if (args === "rev-parse --short HEAD") return HEAD_SHA.slice(0, 7);
  if (args.startsWith("log")) return GIT_LOG_RAW;
  throw new Error(`unexpected git command: ${args}`);
}

function brokenGit(): string {
  throw new Error("git 不可用");
}

/** 哈希取得到但历史读不到，等价于浅克隆里 git log 被截断。 */
function revisionOnlyGit(args: string) {
  if (args === "rev-parse HEAD") return HEAD_SHA;
  if (args === "rev-parse --short HEAD") return HEAD_SHA.slice(0, 7);
  throw new Error("git log 不可用");
}

interface HistoryModule {
  generatedAt: string;
  currentCommit: string;
  commits: { hash: string; message: string; date: string; author: string }[];
}

/** 虚拟模块的产物是一段 `export default {...}` 源码，取回对象才能断言。 */
async function loadHistory(plugin: ReturnType<typeof commitHistoryPlugin>): Promise<HistoryModule> {
  const code = await plugin.load(RESOLVED_ID);
  if (code === null) throw new Error("虚拟模块没有输出内容");

  return JSON.parse(code.replace("export default ", "")) as HistoryModule;
}

function stubFetch(response: { ok: boolean; json?: unknown } | Error) {
  const fetchMock = vi.fn<typeof fetch>(async () => {
    if (response instanceof Error) throw response;
    return { ok: response.ok, json: async () => response.json } as Response;
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("commitHistoryPlugin", () => {
  it("keeps the plugin name storybook excludes", () => {
    expect(commitHistoryPlugin({ useRemote: false, execGit: fakeGit }).name).toBe("commit-history");
  });

  it("only answers for the commit-history virtual id", async () => {
    const plugin = commitHistoryPlugin({ useRemote: false, execGit: fakeGit });

    expect(plugin.resolveId("virtual:commit-history")).toBe(RESOLVED_ID);
    expect(plugin.resolveId("virtual:sticker-manifest")).toBeNull();
    expect(await plugin.load("\0virtual:other")).toBeNull();
  });

  it("reads the remote list when building, pinned to the built revision", async () => {
    const fetchMock = stubFetch({ ok: true, json: GITHUB_PAYLOAD });
    const history = await loadHistory(commitHistoryPlugin({ useRemote: true, execGit: fakeGit }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requested = String(fetchMock.mock.calls[0]?.[0]);
    expect(requested).toContain("https://api.github.com/repos/Cosmosuperbaka/BakaGame/commits");
    expect(requested).toContain(`sha=${HEAD_SHA}`);
    expect(requested).toContain("per_page=30");

    expect(history.commits).toEqual([
      {
        hash: "0123456",
        message: "feat(CCB): 队伍面板与分队玩家栏",
        date: "2026-10-06T01:20:30.000Z",
        author: "Cosmosuperbaka",
      },
    ]);
    // 版本提示与 Sentry release 都读它，必须是本地 HEAD 而不是接口返回的最新提交。
    expect(history.currentCommit).toBe("0123456");
    expect(history.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("never ships the author email to visitors", async () => {
    stubFetch({ ok: true, json: GITHUB_PAYLOAD });
    const code = await commitHistoryPlugin({ useRemote: true, execGit: fakeGit }).load(RESOLVED_ID);

    expect(code).not.toContain("someone@example.com");
    expect(code).not.toContain("email");
  });

  const failureCases: Array<[string, { ok: boolean; json?: unknown } | Error]> = [
    ["非 2xx 响应（限流或构建提交尚未推送）", { ok: false }],
    ["接口返回的不是提交数组", { ok: true, json: { message: "rate limit exceeded" } }],
    ["请求直接抛错", new Error("fetch failed")],
  ];

  for (const [label, response] of failureCases) {
    it(`falls back to the local git log: ${label}`, async () => {
      const fetchMock = stubFetch(response);
      const history = await loadHistory(commitHistoryPlugin({ useRemote: true, execGit: fakeGit }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(history.commits).toEqual([
        {
          hash: "0123456",
          message: "feat(Song): 音量条改为胶囊并可静音",
          date: "2026-10-06T01:35:18.000Z",
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
  }

  it("degrades to an empty list when the remote call fails and git has no history", async () => {
    const fetchMock = stubFetch({ ok: false });
    const history = await loadHistory(
      commitHistoryPlugin({ useRemote: true, execGit: revisionOnlyGit }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(history.commits).toEqual([]);
    expect(history.currentCommit).toBe("0123456");
  });

  it("degrades to an empty list when git itself is unavailable", async () => {
    const fetchMock = stubFetch({ ok: false });
    const history = await loadHistory(commitHistoryPlugin({ useRemote: true, execGit: brokenGit }));

    // 连 HEAD 都取不到就没有可锚定的版本，直接跳过网络请求。
    expect(fetchMock).not.toHaveBeenCalled();
    expect(history.commits).toEqual([]);
    expect(history.currentCommit).toBe("dev");
  });

  it("does not touch the network in dev, and reads the local git log instead", async () => {
    const fetchMock = stubFetch({ ok: true, json: GITHUB_PAYLOAD });
    const history = await loadHistory(commitHistoryPlugin({ useRemote: false, execGit: fakeGit }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(history.commits).toHaveLength(2);
    expect(history.currentCommit).toBe("0123456");
  });

  it("skips the remote call when the revision is unknown", async () => {
    const fetchMock = stubFetch({ ok: true, json: GITHUB_PAYLOAD });
    const history = await loadHistory(
      commitHistoryPlugin({
        useRemote: true,
        execGit: (args) => (args.startsWith("log") ? GIT_LOG_RAW : ""),
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(history.commits).toHaveLength(2);
    expect(history.currentCommit).toBe("dev");
  });

  it("reuses one collection per build instead of re-reading git on every hook", async () => {
    const fetchMock = stubFetch({ ok: true, json: GITHUB_PAYLOAD });
    const plugin = commitHistoryPlugin({ useRemote: true, execGit: fakeGit });

    await plugin.load(RESOLVED_ID);
    await plugin.load(RESOLVED_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
