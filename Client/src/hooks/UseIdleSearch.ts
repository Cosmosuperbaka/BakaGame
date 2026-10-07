import { useCallback, useEffect, useRef, useState } from "react";

/** 停止输入多久后发起查询：连续敲字时不逐字请求上游。 */
export const IDLE_SEARCH_MS = 350;

export interface IdleSearch<T> {
  items: T[];
  loading: boolean;
  /** 这一批结果的标识，结果整批更换时变化（交给 `SearchCombobox` 的 `listKey`） */
  listKey: string;
  error: string;
  /** 当前关键词已查过且没有结果 */
  empty: boolean;
  /** 跳过等待立即查询当前关键词（回车、按钮） */
  flush: () => void;
}

/**
 * 停止输入后自动查询。新查询在途时保留上一批结果（输入框尾部转圈），晚到的旧结果一律丢弃；
 * 清空输入即视为没有结果，不需要等在途请求回来。`enabled` 为假时不发起查询，已有结果原样保留。
 * `scope` 区分同一关键词下的不同查询（CCB 的搜角色 / 搜作品）：换了范围旧结果立即作废，不把另一类结果留在面板里。
 * `search` 与 `describe` 须是稳定引用（store 里的方法、模块级函数），否则每次渲染都会重新计时。
 */
export function useIdleSearch<T>(
  keyword: string,
  search: (keyword: string) => Promise<T[]>,
  describe: (error: unknown) => string,
  { enabled = true, scope = "" }: { enabled?: boolean; scope?: string } = {},
): IdleSearch<T> {
  const query = keyword.trim();
  const [result, setResult] = useState<{ scope: string; keyword: string; items: T[] } | null>(null);
  const [failure, setFailure] = useState<{ scope: string; keyword: string; message: string } | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [flushes, setFlushes] = useState(0);
  const immediate = useRef(false);

  useEffect(() => {
    if (!query || !enabled) return;
    let cancelled = false;
    const delay = immediate.current ? 0 : IDLE_SEARCH_MS;
    immediate.current = false;
    const timer = window.setTimeout(async () => {
      setInFlight(true);
      try {
        const items = await search(query);
        if (!cancelled) { setResult({ scope, keyword: query, items }); setFailure(null); }
      } catch (error) {
        if (!cancelled) setFailure({ scope, keyword: query, message: describe(error) });
      } finally {
        if (!cancelled) setInFlight(false);
      }
    }, delay);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, scope, search, describe, enabled, flushes]);

  const flush = useCallback(() => {
    immediate.current = true;
    setFlushes((count) => count + 1);
  }, []);

  // 同一范围里换了关键词，旧结果留到新结果回来；换了范围立即作废。
  const shown = query && result?.scope === scope ? result : null;
  const items = shown ? shown.items : [];
  const loading = Boolean(query) && enabled && inFlight;
  return {
    items,
    loading,
    listKey: shown ? `results:${scope}:${shown.keyword}` : "none",
    error: query && failure?.scope === scope && failure.keyword === query ? failure.message : "",
    empty: Boolean(shown) && shown?.keyword === query && !loading && items.length === 0,
    flush,
  };
}
