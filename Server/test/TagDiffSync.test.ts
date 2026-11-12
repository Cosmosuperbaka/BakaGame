import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planTagDiff,
  readTagDiffState,
  scheduleTagDiffSync,
  syncTagDiff,
} from "../src/infrastructure/TagDiffSync";

/** 差分是「相对上一版」的增量：基线对不上时宁可不应用，也不能静默漏掉中间轮次。 */
test("基线不匹配判为 stale，绝不套用增量", () => {
  const plan = planTagDiff(
    { baseSha256: "aaa", targetSha256: "bbb", added: { "1": ["蓝发"] } },
    "zzz"
  );
  expect(plan.stale).toBe(true);
  expect(planTagDiff({ baseSha256: null, targetSha256: "bbb" }, "zzz").stale).toBe(false);
  expect(planTagDiff({ baseSha256: "aaa", targetSha256: "bbb" }, "aaa").stale).toBe(false);
  // 没有已应用记录时，非空基线的 diff 同样不能套用：只有首个产物（基线为 null）可以。
  expect(planTagDiff({ baseSha256: "aaa", targetSha256: "bbb" }, undefined).stale).toBe(true);
  expect(planTagDiff({ baseSha256: null, targetSha256: "bbb" }, undefined).stale).toBe(false);
});

test("应用增量后记录版本，重复拉取不再写入", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-tagdiff-"));
  try {
    const statePath = join(directory, "state.json");
    const applied: Array<{ replaced: Array<[number, string[]]>; removed: number[] }> = [];
    const repository = {
      applyTagChanges: async (replaced: Array<[number, string[]]>, removed: number[]) => {
        applied.push({ replaced, removed });
      },
      replaceAllTags: async () => {},
    };
    const payload = {
      generatedAt: "2026-10-10T00:00:00Z",
      baseSha256: null,
      targetSha256: "v1",
      added: { "1": ["蓝发", "眼镜"] },
      changed: { "2": ["主角"] },
      removed: [3],
    };
    const fetcher = (async () =>
      new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;

    const first = await syncTagDiff({
      repository,
      diffUrl: "https://example.invalid/diff.json",
      statePath,
      fetcher,
    });
    expect(first.applied).toBe(true);
    expect(first.replaced).toBe(2);
    expect(first.removed).toBe(1);
    expect(applied[0]!.replaced).toEqual([
      [1, ["蓝发", "眼镜"]],
      [2, ["主角"]],
    ]);
    expect(applied[0]!.removed).toEqual([3]);

    const second = await syncTagDiff({
      repository,
      diffUrl: "https://example.invalid/diff.json",
      statePath,
      fetcher,
    });
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
    await expect(
      syncTagDiff({
        repository: { applyTagChanges: async () => {}, replaceAllTags: async () => {} },
        diffUrl: "https://example.invalid/diff.json",
        statePath,
        fetcher,
      })
    ).rejects.toThrow("HTTP 502");
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
    const fetcher = (async () =>
      new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    const info: string[] = [];
    const spy = spyOn(globalThis, "setTimeout");
    try {
      const stop = scheduleTagDiffSync({
        repository: () => ({
          applyTagChanges: async () => {
            applied += 1;
          },
          replaceAllTags: async () => {},
        }),
        diffUrl: "https://example.invalid/diff.json",
        statePath,
        fetcher,
        logger: { info: (message) => info.push(message) },
      });
      // 首跑延后：刚起来时索引在重建，别抢窗口。
      expect(Number(spy.mock.calls.at(-1)![1])).toBe(60_000);
      const ticksBeforeRun = spy.mock.calls.length;
      (spy.mock.calls.at(-1)![0] as () => void)();
      // 计时回调是同步外壳，本轮同步跑完才排下一次；等那条 6 小时排程出现再断言。
      for (let attempt = 0; attempt < 50 && spy.mock.calls.length === ticksBeforeRun; attempt += 1)
        await Bun.sleep(1);
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

test("每轮结果回报给状态页：已是最新算成功，基线不匹配且全量重建失败与拉取失败算失败", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-tagdiff-"));
  const statePath = join(directory, "state.json");
  type Result = { ok: boolean; summary: string; error: string | null };
  const runOnce = async (fetcher: typeof fetch): Promise<Result> => {
    const spy = spyOn(globalThis, "setTimeout");
    try {
      return await new Promise<Result>((resolve) => {
        const stop = scheduleTagDiffSync({
          repository: () => ({ applyTagChanges: async () => {}, replaceAllTags: async () => {} }),
          diffUrl: "https://example.invalid/diff.json",
          statePath,
          fetcher,
          onResult: (result) => {
            stop();
            resolve(result);
          },
        });
        (spy.mock.calls.at(-1)![0] as () => void)();
      });
    } finally {
      spy.mockRestore();
    }
  };
  const respondWith = (payload: unknown) =>
    (async () => Response.json(payload)) as unknown as typeof fetch;

  try {
    const first = { baseSha256: null, targetSha256: "v1", added: { "1": ["蓝发"] } };
    expect(await runOnce(respondWith(first))).toMatchObject({ ok: true, error: null });
    expect(await runOnce(respondWith(first))).toEqual({
      ok: true,
      summary: "已是最新版本",
      error: null,
    });
    // 基线对不上又拿不到全量产物（这里的假上游对任何地址都回同一份 diff）：必须报失败，不能静默。
    const stale = await runOnce(respondWith({ baseSha256: "aaa", targetSha256: "v2" }));
    expect(stale.ok).toBe(false);
    expect(stale.summary).toContain("增量同步失败");
    const failed = await runOnce(
      (async () => new Response(null, { status: 503 })) as unknown as typeof fetch
    );
    expect(failed).toMatchObject({ ok: false, summary: "增量同步失败" });
    expect(failed.error).toContain("503");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const withState = (statePath: string, state: unknown) =>
  Bun.write(statePath, JSON.stringify(state));

test("基线不匹配时拉全量重建并写入 targetSha256，下一轮增量恢复", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-tagdiff-"));
  try {
    const statePath = join(directory, "state.json");
    await withState(statePath, { appliedSha256: "old" });
    const calls: string[] = [];
    const full = { "1": ["蓝发"], "2": ["主角", "眼镜"] };
    const fetcher = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("id_tags.json")) return Response.json(full);
      return Response.json({ baseSha256: "missed", targetSha256: "v3", added: { "9": ["x"] } });
    }) as unknown as typeof fetch;
    const rebuilt: Array<Array<[number, string[]]>> = [];
    const applied: number[] = [];
    const repository = {
      applyTagChanges: async (replaced: Array<[number, string[]]>) => {
        applied.push(replaced.length);
      },
      replaceAllTags: async (entries: Array<[number, string[]]>) => {
        rebuilt.push(entries);
      },
    };

    const result = await syncTagDiff({
      repository,
      diffUrl: "https://example.invalid/outputs/id_tags.diff.json",
      statePath,
      fetcher,
    });
    expect(result).toMatchObject({ applied: true, targetSha256: "v3" });
    expect(result.reason).toContain("全量");
    expect(calls).toEqual([
      "https://example.invalid/outputs/id_tags.diff.json",
      "https://example.invalid/outputs/id_tags.json",
    ]);
    expect(rebuilt).toEqual([
      [
        [1, ["蓝发"]],
        [2, ["主角", "眼镜"]],
      ],
    ]);
    // 全量重建后不再把那份基线对不上的 diff 套一遍。
    expect(applied).toEqual([]);
    expect(readTagDiffState(statePath).appliedSha256).toBe("v3");

    // 下一轮：上游的 diff 以 v3 为基线，走普通增量。
    const next = (async () =>
      Response.json({
        baseSha256: "v3",
        targetSha256: "v4",
        changed: { "1": ["紫发"] },
      })) as unknown as typeof fetch;
    const second = await syncTagDiff({
      repository,
      diffUrl: "https://example.invalid/outputs/id_tags.diff.json",
      statePath,
      fetcher: next,
    });
    expect(second).toMatchObject({ applied: true, replaced: 1 });
    expect(applied).toEqual([1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("没有状态文件而 diff 有非空基线时同样走全量，不拿任意 diff 硬套", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-tagdiff-"));
  try {
    const statePath = join(directory, "state.json");
    const rebuilt: number[] = [];
    const applied: number[] = [];
    const fetcher = (async (url: string) =>
      url.endsWith("id_tags.json")
        ? Response.json({ "1": ["蓝发"] })
        : Response.json({ baseSha256: "aaa", targetSha256: "bbb" })) as unknown as typeof fetch;
    const result = await syncTagDiff({
      repository: {
        applyTagChanges: async () => void applied.push(1),
        replaceAllTags: async (entries) => void rebuilt.push(entries.length),
      },
      diffUrl: "https://example.invalid/id_tags.diff.json",
      statePath,
      fetcher,
    });
    expect(result.applied).toBe(true);
    expect(rebuilt).toEqual([1]);
    expect(applied).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("显式配置的全量地址优先于由 diff 地址推导的", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-tagdiff-"));
  try {
    const statePath = join(directory, "state.json");
    await withState(statePath, { appliedSha256: "old" });
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      return url.includes("full.example")
        ? Response.json({ "1": ["蓝发"] })
        : Response.json({ baseSha256: "aaa", targetSha256: "bbb" });
    }) as unknown as typeof fetch;
    await syncTagDiff({
      repository: { applyTagChanges: async () => {}, replaceAllTags: async () => {} },
      diffUrl: "https://example.invalid/a/id_tags.diff.json",
      fullUrl: "https://full.example/custom.json",
      statePath,
      fetcher,
    });
    expect(calls[1]).toBe("https://full.example/custom.json");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("全量产物形状不对时报错且不写状态，基线继续卡着等人处理", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-tagdiff-"));
  try {
    const statePath = join(directory, "state.json");
    await withState(statePath, { appliedSha256: "old" });
    const fetcher = (async (url: string) =>
      url.endsWith("id_tags.json")
        ? Response.json({ "1": "不是数组" })
        : Response.json({ baseSha256: "aaa", targetSha256: "bbb" })) as unknown as typeof fetch;
    await expect(
      syncTagDiff({
        repository: { applyTagChanges: async () => {}, replaceAllTags: async () => {} },
        diffUrl: "https://example.invalid/id_tags.diff.json",
        statePath,
        fetcher,
      })
    ).rejects.toThrow("全量标签");
    expect(readTagDiffState(statePath).appliedSha256).toBe("old");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("已应用到最新版本时，即使 diff 带非空基线也判为已是最新，不触发全量重建", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-tagdiff-"));
  try {
    const statePath = join(directory, "state.json");
    await withState(statePath, { appliedSha256: "v2" });
    let rebuilt = 0;
    const fetcher = (async () =>
      Response.json({ baseSha256: "v1", targetSha256: "v2" })) as unknown as typeof fetch;
    const result = await syncTagDiff({
      repository: {
        applyTagChanges: async () => {},
        replaceAllTags: async () => void (rebuilt += 1),
      },
      diffUrl: "https://example.invalid/id_tags.diff.json",
      statePath,
      fetcher,
    });
    expect(result).toMatchObject({ applied: false, reason: "已是最新版本" });
    expect(rebuilt).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
