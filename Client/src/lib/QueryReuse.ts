/**
 * 只读查询的结果复用窗口。
 *
 * 各类「搜索 / 解析」输入框自身有防抖，挡的是「打字过程中」的抖动；挡不住
 * 「来回切换同一个输入」—— 反复搜同一个歌名、来回贴同一个歌单链接、重复搜同一串关键词。
 * 这类重复在真实对局里占比很高，用同一套「命中即复用 + 同键合并」的语义收敛掉。
 *
 * 收益边界要写清楚：服务端本来就按关键词缓存（搜索 / 歌单 6 小时、歌手歌曲 24 小时），
 * 所以这里减少的是 **WS 往返与等待**，而不是对上游的请求数 ——
 * 上游请求量只由「唯一输入」决定，客户端缓存动不了它。
 */
const QUERY_REUSE_TTL_MS = 5 * 60_000;
const QUERY_REUSE_MAX_ENTRIES = 50;

export interface QueryReuseCache<T> {
  /** 命中窗口内直接返回上次结果；未命中则回源并写入；同键在途请求合并为一次。 */
  run: (key: string, load: () => Promise<T>) => Promise<T>;
  clear: () => void;
}

/** 造一个「读透窗口」。`normalize` 决定哪些输入算同一个 key。 */
export function createQueryReuseCache<T>(
  normalize: (value: string) => string,
): QueryReuseCache<T> {
  const entries = new Map<string, { at: number; value: T }>();
  const inFlight = new Map<string, Promise<T>>();

  return {
    async run(key, load) {
      const normalized = normalize(key);
      // 空输入不缓存：它没有检索意义，也不该占用窗口。
      if (!normalized) return load();

      const hit = entries.get(normalized);
      if (hit) {
        if (Date.now() - hit.at <= QUERY_REUSE_TTL_MS) {
          // 命中即刷新顺序，让「最近用过」的条目最后被淘汰。
          entries.delete(normalized);
          entries.set(normalized, hit);
          return hit.value;
        }
        entries.delete(normalized);
      }

      // 同键合并：防抖之后仍可能撞上并发（快速回退再提交同一串）。
      const pending = inFlight.get(normalized);
      if (pending) return pending;

      const task = (async () => {
        const value = await load();
        entries.set(normalized, { at: Date.now(), value });
        if (entries.size > QUERY_REUSE_MAX_ENTRIES) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
        return value;
      })();

      inFlight.set(normalized, task);
      try {
        return await task;
      } finally {
        // 成功已写入窗口；失败时清掉在途标记，下一次调用照常回源（失败结果绝不进缓存）。
        inFlight.delete(normalized);
      }
    },
    clear() {
      entries.clear();
      inFlight.clear();
    },
  };
}

/** 关键词类输入：大小写与首尾空白不影响检索结果，避免「晴天」「晴天 」各打一次。 */
export const keywordQueryKey = (value: string) => value.trim().toLowerCase();

/** 精确类输入（如歌单链接 / 番剧 ID）：只去空白，不折叠大小写 —— URL 路径可能大小写敏感。 */
export const exactQueryKey = (value: string) => value.trim();
