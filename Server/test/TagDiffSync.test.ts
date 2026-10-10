import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planTagDiff, scheduleTagDiffSync, syncTagDiff } from "../src/infrastructure/TagDiffSync";

/** 差分是「相对上一版」的增量：基线对不上时宁可不应用，也不能静默漏掉中间轮次。 */
test("基线不匹配判为 stale，绝不套用增量", () => {
  const plan = planTagDiff(
    { baseSha256: "aaa", targetSha256: "bbb", added: { "1": ["蓝发"] } },
    "zzz",
  );
  expect(plan.stale).toBe(true);
  expect(planTagDiff({ baseSha256: null, targetSha256: "bbb" }, "zzz").stale).toBe(false);
  expect(planTagDiff({ baseSha256: "aaa", targetSha256: "bbb" }, "aaa").stale).toBe(false);
});

test("应用增量后记录版本，重复拉取不再写入", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-tagdiff-"));
  try {
    const statePath = join(directory, "state.json");
    const applied: Array<{ replaced: Array<[number, string[]]>; removed: number[] }> = [];
    const repository = {
      applyTagChanges: async (replaced: Array<[number, string[]]>, removed: number[]) => { applied.push({ replaced, removed }); },
    };
    const payload = {
      generatedAt: "2026-10-10T00:00:00Z", baseSha256: null, targetSha256: "v1",
      added: { "1": ["蓝发", "眼镜"] }, changed: { "2": ["主角"] }, removed: [3],
    };
    const fetcher = (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;

    const first = await syncTagDiff({ repository, diffUrl: "https://example.invalid/diff.json", statePath, fetcher });
    expect(first.applied).toBe(true);
    expect(first.replaced).toBe(2);
    expect(first.removed).toBe(1);
    expect(applied[0]!.replaced).toEqual([[1, ["蓝发", "眼镜"]], [2, ["主角"]]]);
    expect(applied[0]!.removed).toEqual([3]);

    const second = await syncTagDiff({ repository, diffUrl: "https://example.invalid/diff.json", statePath, fetcher });
    expect(second.applied).toBe(false);
    expect(second.reason).toBe("已是最新版本");
    expect(applied).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("上游非 2xx 时抛错，不写状态文件", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-tagdiff-"));
  try {
    const statePath = join(directory, "state.json");
    const fetcher = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    await expect(syncTagDiff({
      repository: { applyTagChanges: async () => {} }, diffUrl: "https://example.invalid/diff.json", statePath, fetcher,
    })).rejects.toThrow("HTTP 502");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("定时同步：首跑延后一分钟，之后每 6 小时一轮，stop 后不再排程", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-tagdiff-"));
  try {
    const statePath = join(directory, "state.json");
    let applied = 0;
    const payload = { baseSha256: null, targetSha256: "v1", added: { "1": ["蓝发"] } };
    const fetcher = (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    const info: string[] = [];
    const spy = spyOn(globalThis, "setTimeout");
    try {
      const stop = scheduleTagDiffSync({
        repository: () => ({ applyTagChanges: async () => { applied += 1; } }),
        diffUrl: "https://example.invalid/diff.json", statePath, fetcher,
        logger: { info: (message) => info.push(message) },
      });
      // 首跑延后：刚起来时索引在重建，别抢窗口。
      expect(Number(spy.mock.calls.at(-1)![1])).toBe(60_000);
      await (spy.mock.calls.at(-1)![0] as () => Promise<void>)();
      expect(applied).toBe(1);
      expect(info[0]).toContain("角色标签增量已应用");
      expect(Number(spy.mock.calls.at(-1)![1])).toBe(6 * 60 * 60 * 1_000);
      stop();
    } finally {
      spy.mockRestore();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
