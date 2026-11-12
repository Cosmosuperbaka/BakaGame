import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BANGUMI_TAG_DIFF_TIMEOUT_MS, BANGUMI_TAG_FULL_TIMEOUT_MS } from "../config/Constants";
import { AppError } from "../domain/Errors";
import type { CEECharacterRepository } from "./CEECharacterRepository";
import { BANGUMI_USER_AGENT } from "./BangumiUserAgent";

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

/** 全量重建需要的仓库能力：整表替换，与增量的逐角色替换分开。 */
export type TagSyncRepository = Pick<CEECharacterRepository, "applyTagChanges" | "replaceAllTags">;

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
/** 未应用的正常原因：只有它算成功，其余未应用（如基线不匹配）都需要有人处理。 */
const TAG_DIFF_UP_TO_DATE = "已是最新版本";
const FIRST_DELAY_MS = 60_000;

export function scheduleTagDiffSync(options: {
  /** 取仓库的回调：初始化可能失败或尚未完成，用时再取。 */
  repository: () => TagSyncRepository;
  diffUrl: string;
  /** 基线对不上时回退全量重建的产物地址；缺省由 `diffUrl` 同目录推导。 */
  fullUrl?: string;
  statePath: string;
  fetcher?: typeof fetch;
  logger?: { warn?: (message: string) => void; info?: (message: string) => void };
  /** 每轮结束回报结果，供状态页留痕。 */
  onResult?: (result: { ok: boolean; summary: string; error: string | null }) => void;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (): Promise<void> => {
    try {
      const result = await syncTagDiff({
        repository: options.repository(),
        diffUrl: options.diffUrl,
        fullUrl: options.fullUrl,
        statePath: options.statePath,
        fetcher: options.fetcher,
      });
      if (result.applied) {
        if (result.reason) options.logger?.info?.(`角色标签增量：${result.reason}`);
        const summary = `${result.replaced} 条变更 / ${result.removed} 条移除`;
        options.logger?.info?.(`角色标签增量已应用：${summary}`);
        options.onResult?.({ ok: true, summary: `已应用 ${summary}`, error: null });
      } else if (result.reason) {
        options.logger?.info?.(`角色标签增量未应用：${result.reason}`);
        options.onResult?.({
          ok: result.reason === TAG_DIFF_UP_TO_DATE,
          summary: result.reason,
          error: null,
        });
      }
    } catch (error) {
      // 增量同步失败不影响服务：下一轮会重试，库里的标签仍是上一版。
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.warn?.(`角色标签增量同步失败：${message}`);
      options.onResult?.({ ok: false, summary: "增量同步失败", error: message });
    }
  };
  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      // 无论这一轮怎么收场（含回调自己抛错）都要续排，否则轮询会悄无声息地永久停摆。
      void run()
        .catch((error: unknown) =>
          options.logger?.warn?.(
            `角色标签增量收尾失败：${error instanceof Error ? error.message : String(error)}`
          )
        )
        .finally(() => schedule(SYNC_INTERVAL_MS));
    }, delay);
  };
  schedule(FIRST_DELAY_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export function readTagDiffState(statePath: string): TagDiffState {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as TagDiffState;
  } catch {
    // 文件不存在或损坏都视作「未记录」：此时只有基线为空的首个产物能直接套用，其余走全量重建。
    return {};
  }
}

export function planTagDiff(payload: TagDiffPayload, appliedSha256: string | undefined) {
  const replaced = [
    ...Object.entries(payload.added ?? {}),
    ...Object.entries(payload.changed ?? {}),
  ].map(([id, tags]) => [Number(id), tags] as [number, string[]]);
  const removed = (payload.removed ?? []).map(Number);
  const counts = payload.counts ?? {};
  return {
    replaced,
    removed,
    summary: `新增 ${counts.added ?? replaced.length} / 变更 ${counts.changed ?? 0} / 移除 ${counts.removed ?? removed.length}`,
    // 没有已应用记录等同于「不知道本地停在哪一版」，只能全量重建，不能拿任意 diff 硬套。
    stale: payload.baseSha256 !== null && appliedSha256 !== payload.baseSha256,
  };
}

/** 同目录下的全量产物：上游稳定发布的是 `id_tags.json`，diff 产物才是会变动的那个。 */
export function deriveFullTagsUrl(diffUrl: string): string {
  const url = new URL(diffUrl);
  url.pathname = url.pathname.replace(/[^/]*$/, "id_tags.json");
  url.search = "";
  return url.toString();
}

/** 全量产物是 `{角色编号: 标签数组}`；形状不对说明上游改了格式，必须报错而不是清空标签表。 */
function parseFullTags(raw: unknown): Array<[number, string[]]> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new AppError("BANGUMI_DATA_INVALID", "全量标签产物不是对象");
  const entries: Array<[number, string[]]> = [];
  for (const [key, tags] of Object.entries(raw)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id <= 0)
      throw new AppError("BANGUMI_DATA_INVALID", `全量标签产物含非法角色编号：${key}`);
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))
      throw new AppError("BANGUMI_DATA_INVALID", `全量标签产物中角色 ${key} 的标签不是字符串数组`);
    entries.push([id, tags as string[]]);
  }
  if (entries.length === 0) throw new AppError("BANGUMI_DATA_INVALID", "全量标签产物为空");
  return entries;
}

/** 先写临时文件再改名：进程中途被杀时状态文件要么是旧的、要么是新的，不会是半截。 */
function writeTagDiffState(statePath: string, state: TagDiffState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  renameSync(temporary, statePath);
}

/**
 * 拉取并应用角色标签增量。
 *
 * 为什么要校验 `baseSha256`：diff 只描述「相对上一版」的变化。本地记录的版本与 diff 的
 * 基线对不上，说明中间漏过轮次 —— 直接套用会**静默漏掉**那些轮次的变更，比不更新更糟。
 * 这时退回全量产物整表重建，并把本次 diff 的 `targetSha256` 记为新基线，下一轮即恢复增量；
 * 否则基线会永远停在旧版、每一轮都对不上。
 *
 * `removed` 与 `changed` 都必须处理：角色被合并/删除时标签要跟着走，否则会留下指向
 * 不存在角色的悬空行 —— 它在按标签取角色时会变成一个空候选。
 */
export async function syncTagDiff(options: {
  repository: TagSyncRepository;
  /** diff 的拉取地址（CCB-TagsCI 的 outputs/id_tags.diff.json）。 */
  diffUrl: string;
  /** 全量产物地址；缺省取 diff 同目录的 `id_tags.json`。 */
  fullUrl?: string;
  /** 已应用版本的记录文件。 */
  statePath: string;
  fetcher?: typeof fetch;
}): Promise<TagDiffResult> {
  const fetcher = options.fetcher ?? fetch;
  const fetchJson = async (url: string, what: string, timeoutMs: number): Promise<unknown> => {
    const response = await fetcher(url, {
      headers: { Accept: "application/json", "User-Agent": BANGUMI_USER_AGENT },
      // 半开连接或卡住的反代不会自己结束：没有超时，这一轮永不返回，定时链就此断掉。
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new AppError("BANGUMI_DATA_UNAVAILABLE", `拉取${what}失败：HTTP ${response.status}`);
    return response.json();
  };
  const payload = (await fetchJson(
    options.diffUrl,
    "标签增量",
    BANGUMI_TAG_DIFF_TIMEOUT_MS
  )) as TagDiffPayload;
  if (!payload?.targetSha256)
    throw new AppError("BANGUMI_DATA_INVALID", "标签增量缺少 targetSha256");

  const state = readTagDiffState(options.statePath);
  const plan = planTagDiff(payload, state.appliedSha256);
  if (state.appliedSha256 === payload.targetSha256) {
    return {
      applied: false,
      reason: TAG_DIFF_UP_TO_DATE,
      replaced: 0,
      removed: 0,
      targetSha256: payload.targetSha256,
    };
  }
  if (plan.stale) {
    const entries = parseFullTags(
      await fetchJson(
        options.fullUrl ?? deriveFullTagsUrl(options.diffUrl),
        "全量标签",
        BANGUMI_TAG_FULL_TIMEOUT_MS
      )
    );
    await options.repository.replaceAllTags(entries);
    writeTagDiffState(options.statePath, {
      appliedSha256: payload.targetSha256,
      generatedAt: payload.generatedAt,
      characters: entries.length,
    });
    return {
      applied: true,
      reason: "基线不匹配，已用全量标签重建",
      replaced: entries.length,
      removed: 0,
      targetSha256: payload.targetSha256,
    };
  }

  await options.repository.applyTagChanges(plan.replaced, plan.removed);
  writeTagDiffState(options.statePath, {
    appliedSha256: payload.targetSha256,
    generatedAt: payload.generatedAt,
    characters: payload.counts?.total,
  });

  return {
    applied: true,
    replaced: plan.replaced.length,
    removed: plan.removed.length,
    targetSha256: payload.targetSha256,
  };
}
