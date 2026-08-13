import { useCallback, useEffect, useRef } from "react";

interface AutoSaveOptions {
  delayMs?: number;
  enabled?: boolean;
  onError?: (error: unknown) => void;
}

interface SaveDraft<T> {
  key: string;
  value: T;
}

/** 文本输入防抖、所有提交串行；保存期间发生的新修改只保留最后一份草稿。 */
export function useAutoSave<T>(
  value: T,
  save: (value: T) => Promise<unknown>,
  options: AutoSaveOptions = {},
) {
  const delayMs = options.delayMs ?? 400;
  const enabled = options.enabled ?? true;
  const key = JSON.stringify(value);

  const desiredRef = useRef<SaveDraft<T>>({ key, value });
  const savedKeyRef = useRef(key);
  const saveRef = useRef(save);
  const errorRef = useRef(options.onError);
  const enabledRef = useRef(enabled);
  const pendingRef = useRef<SaveDraft<T> | null>(null);
  const savingRef = useRef(false);
  const failedKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const flushAfterUnmountRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<() => void>(() => {});

  // 这些 ref 在 effect 中更新，避免渲染阶段读写 ref，也让定时器始终拿到最新回调和值。
  useEffect(() => {
    desiredRef.current = { key, value };
    saveRef.current = save;
    errorRef.current = options.onError;
    enabledRef.current = enabled;
  }, [enabled, key, options.onError, save, value]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flush = useCallback(() => {
    clearTimer();
    if (savingRef.current || !enabledRef.current) return;

    const desired = desiredRef.current;
    const pending = pendingRef.current ??
      (desired.key !== savedKeyRef.current ? desired : null);
    if (!pending) return;

    pendingRef.current = null;
    savingRef.current = true;
    void Promise.resolve(saveRef.current(pending.value))
      .then(() => {
        savedKeyRef.current = pending.key;
        failedKeyRef.current = null;
      })
      .catch((error) => {
        // 失败值等待下一次用户修改，避免服务异常时自动保存无限重试。
        failedKeyRef.current = pending.key;
        errorRef.current?.(error);
      })
      .finally(() => {
        savingRef.current = false;
        // 如果请求进行期间用户又改过值（包括改回旧值），补交最新草稿，
        // 防止服务端完成顺序把界面上的最后修改覆盖掉。
        const latest = desiredRef.current;
        if (
          (mountedRef.current || flushAfterUnmountRef.current) &&
          enabledRef.current &&
          latest.key !== savedKeyRef.current &&
          latest.key !== failedKeyRef.current
        ) {
          pendingRef.current = latest;
          timerRef.current = setTimeout(() => flushRef.current(), Math.max(0, delayMs));
        }
        flushAfterUnmountRef.current = false;
      });
  }, [clearTimer, delayMs]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  useEffect(() => {
    if (!enabled) {
      clearTimer();
      pendingRef.current = null;
      failedKeyRef.current = null;
      return;
    }

    if (key !== failedKeyRef.current) failedKeyRef.current = null;

    const desired = desiredRef.current;
    if (
      (desired.key === savedKeyRef.current || desired.key === failedKeyRef.current) &&
      !savingRef.current
    ) {
      clearTimer();
      pendingRef.current = null;
      return;
    }

    // 覆盖尚未发送的旧草稿；若旧请求正在飞行，则保留这一份作为补偿提交。
    pendingRef.current = desired;
    clearTimer();
    timerRef.current = setTimeout(() => flushRef.current(), Math.max(0, delayMs));
    return clearTimer;
  }, [clearTimer, delayMs, enabled, flush, key]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      clearTimer();
      // 卸载前把最后一份草稿放入串行队列，避免切换页面丢设置。
      if (enabledRef.current) {
        if (savingRef.current) flushAfterUnmountRef.current = true;
        else flushRef.current();
      }
    };
    // This cleanup is intentionally tied to mount/unmount, not to value changes.
  }, [clearTimer]);
}
