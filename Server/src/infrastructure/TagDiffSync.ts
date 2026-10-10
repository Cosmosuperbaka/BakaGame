import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../domain/Errors";
import type { CCBCharacterRepository } from "./CCBCharacterRepository";

/** CCB-TagsCI 的增量产物（见其 `user_tag_processor._write_diff`）。 */
export interface TagDiffPayload {
  generatedAt?: string;
  /** 上一版 id_tags.js 的 sha256；首次产出时为 null。 */
  baseSha256: string | null;
  /** 本次产物的 sha256，应用成功后记下来作为下一轮基线。 */
  targetSha256: string;
  counts?: { total?: number; added?: number; changed?: number; removed?: number };
  added?: Record<string, string[]>;
  changed?: Record<string, string[]>;
  removed?: Array<string | number>;
}

export interface TagDiffState {
  appliedSha256?: string;
  generatedAt?: string;
  characters?: number;
}

export interface TagDiffResult {
  applied: boolean;
  reason?: string;
  replaced: number;
  removed: number;
  targetSha256?: string;
}

/**
 * 定时拉取标签增量：CCB-TagsCI 每天产一次 diff，6 小时一拉足够新鲜。
 *
 * 用递归 `setTimeout` 而不是 `setInterval`：一轮跑得慢（或上游卡住）时不会
 * 叠加出并发的拉取，下一轮始终从这一轮结束开始计时。
 * 首跑延后一分钟 —— 刚起来时索引正在重建，别去抢它的窗口。
 */
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const FIRST_DELAY_MS = 60_000;

export function scheduleTagDiffSync(options: {
  /** 取仓库的回调：初始化可能失败或尚未完成，用时再取。 */
  repository: () => Pick<CCBCharacterRepository, "applyTagChanges">;
  diffUrl: string;
  statePath: string;
  fetcher?: typeof fetch;
  logger?: { warn?: (message: string) => void; info?: (message: string) => void };
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (): Promise<void> => {
    try {
      const result = await syncTagDiff({
        repository: options.repository(), diffUrl: options.diffUrl, statePath: options.statePath, fetcher: options.fetcher,
      });
      if (result.applied) {
        options.logger?.info?.(`角色标签增量已应用：${result.replaced} 条变更 / ${result.removed} 条移除`);
      } else if (result.reason) {
        options.logger?.info?.(`角色标签增量未应用：${result.reason}`);
      }
    } catch (error) {
      // 增量同步失败不影响服务：下一轮会重试，库里的标签仍是上一版。
      options.logger?.warn?.(`角色标签增量同步失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(async () => { await run(); schedule(SYNC_INTERVAL_MS); }, delay);
  };
  schedule(FIRST_DELAY_MS);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

export function readTagDiffState(statePath: string): TagDiffState {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as TagDiffState;
  } catch {
    // 文件不存在或损坏都视作「未记录」：下面会按全量基线应用并记下来。
    return {};
  }
}

export function planTagDiff(payload: TagDiffPayload, appliedSha256: string | undefined) {
  const replaced = [...Object.entries(payload.added ?? {}), ...Object.entries(payload.changed ?? {})]
    .map(([id, tags]) => [Number(id), tags] as [number, string[]]);
  const removed = (payload.removed ?? []).map(Number);
  const counts = payload.counts ?? {};
  return {
    replaced,
    removed,
    summary: `新增 ${counts.added ?? replaced.length} / 变更 ${counts.changed ?? 0} / 移除 ${counts.removed ?? removed.length}`,
    stale: typeof appliedSha256 === "string" && payload.baseSha256 !== null && appliedSha256 !== payload.baseSha256,
  };
}

/**
 * 拉取并应用角色标签增量。
 *
 * 为什么要校验 `baseSha256`：diff 只描述「相对上一版」的变化。本地记录的版本与 diff 的
 * 基线对不上，说明中间漏过轮次 —— 直接套用会**静默漏掉**那些轮次的变更，比不更新更糟。
 * 这种情况返回 applied=false，由上层的全量重建兜底。
 *
 * `removed` 与 `changed` 都必须处理：角色被合并/删除时标签要跟着走，否则会留下指向
 * 不存在角色的悬空行 —— 它在按标签取角色时会变成一个空候选。
 */
export async function syncTagDiff(options: {
  repository: Pick<CCBCharacterRepository, "applyTagChanges">;
  /** diff 的拉取地址（CCB-TagsCI 的 outputs/id_tags.diff.json）。 */
  diffUrl: string;
  /** 已应用版本的记录文件。 */
  statePath: string;
  fetcher?: typeof fetch;
}): Promise<TagDiffResult> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(options.diffUrl, { headers: { Accept: "application/json", "User-Agent": "BakaGame/1.0" } });
  if (!response.ok) throw new AppError("BANGUMI_DATA_UNAVAILABLE", `拉取标签增量失败：HTTP ${response.status}`);
  const payload = await response.json() as TagDiffPayload;
  if (!payload?.targetSha256) throw new AppError("BANGUMI_DATA_INVALID", "标签增量缺少 targetSha256");

  const state = readTagDiffState(options.statePath);
  const plan = planTagDiff(payload, state.appliedSha256);
  if (plan.stale) {
    return { applied: false, reason: "基线不匹配，需要全量重建", replaced: 0, removed: 0 };
  }
  if (state.appliedSha256 === payload.targetSha256) {
    return { applied: false, reason: "已是最新版本", replaced: 0, removed: 0, targetSha256: payload.targetSha256 };
  }

  await options.repository.applyTagChanges(plan.replaced, plan.removed);

  mkdirSync(dirname(options.statePath), { recursive: true });
  writeFileSync(options.statePath, JSON.stringify({
    appliedSha256: payload.targetSha256,
    generatedAt: payload.generatedAt,
    characters: payload.counts?.total,
  }, null, 2), "utf8");

  return { applied: true, replaced: plan.replaced.length, removed: plan.removed.length, targetSha256: payload.targetSha256 };
}
