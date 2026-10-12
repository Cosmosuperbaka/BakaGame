import { useCallback, useEffect, useRef, useState } from "react";
import { apiErrorMessage } from "@/lib/Api";

export interface AdminQuery<T> {
  /** 最近一次成功的结果；重新查询期间保留，避免表格闪空。 */
  data: T | null;
  /** 当前参数的请求还没回来。 */
  loading: boolean;
  /** 当前参数的请求失败文案。 */
  error: string | null;
  reload: () => void;
}

/**
 * 后台面板的读取：`key` 变化或调用 `reload` 时重新请求，晚到的旧结果丢弃。
 * `fetcher` 只在 `key` 或 `reload` 触发时读取，调用方不必保持它的引用稳定。
 */
export function useAdminQuery<T>(key: string, fetcher: () => Promise<T>, fallback = "加载失败，请稍后重试"): AdminQuery<T> {
  const [version, setVersion] = useState(0);
  const token = `${key}#${version}`;
  const [result, setResult] = useState<{ token: string; data: T | null; error: string | null } | null>(null);
  const [latest, setLatest] = useState<T | null>(null);
  const fetcherRef = useRef(fetcher);
  // 先于下面的读取执行：读取总是用本次渲染的 fetcher。
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    let alive = true;
    fetcherRef.current().then(
      (data) => {
        if (!alive) return;
        setLatest(data);
        setResult({ token, data, error: null });
      },
      (cause: unknown) => alive && setResult({ token, data: null, error: apiErrorMessage(cause, fallback) }),
    );
    return () => {
      alive = false;
    };
  }, [token, fallback]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const settled = result?.token === token;
  return { data: latest, loading: !settled, error: settled ? result.error : null, reload };
}

/** 把写操作包成「进行中 / 失败文案」，成功后执行 `onDone`。 */
export function useAdminAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (name: string, action: () => Promise<unknown>, fallback = "操作失败，请稍后重试") => {
    setBusy(name);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(apiErrorMessage(cause, fallback));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}
