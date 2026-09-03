import { useCallback, useEffect, useRef } from "react";
import equal from "fast-deep-equal";

interface AutoSaveOptions {
  delayMs?: number;
  enabled?: boolean;
  onError?: (error: unknown) => void;
}

/** 文本输入防抖、所有提交串行；保存期间发生的新修改只保留最后一份草稿。 */
export function useAutoSave<T>(
  value: T,
  save: (value: T) => Promise<unknown>,
  options: AutoSaveOptions = {},
) {
  const delayMs = options.delayMs ?? 400;
  const enabled = options.enabled ?? true;

  const desiredRef = useRef<T>(value);
  const savedValueRef = useRef<T>(value);
  const saveRef = useRef(save);
  const errorRef = useRef(options.onError);
  const enabledRef = useRef(enabled);
  const pendingRef = useRef<T | null>(null);
  const hasPendingRef = useRef(false);
  const savingRef = useRef(false);
  const failedValueRef = useRef<T | null>(null);
  const hasFailedRef = useRef(false);
  const mountedRef = useRef(true);
  const flushAfterUnmountRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<() => void>(() => {});

  // 同步更新 enabledRef，避免因 React 卸载阶段跳过 effect 导致执行过期的 enabled 自动保存
  enabledRef.current = enabled;

  // 这些 ref 在 effect 中更新，避免渲染阶段读写 ref，也让定时器始终拿到最新回调和值。
  useEffect(() => {
    desiredRef.current = value;
    saveRef.current = save;
    errorRef.current = options.onError;
    enabledRef.current = enabled;
  }, [enabled, options.onError, save, value]);

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
    let pendingToSave: T;

    if (hasPendingRef.current) {
      pendingToSave = pendingRef.current as T;
    } else if (!equal(desired, savedValueRef.current)) {
      pendingToSave = desired;
    } else {
      return;
    }

    pendingRef.current = null;
    hasPendingRef.current = false;
    savingRef.current = true;

    void Promise.resolve(saveRef.current(pendingToSave))
      .then(() => {
        savedValueRef.current = pendingToSave;
        failedValueRef.current = null;
        hasFailedRef.current = false;
      })
      .catch((error) => {
        // 失败值等待下一次用户修改，避免服务异常时自动保存无限重试。
        failedValueRef.current = pendingToSave;
        hasFailedRef.current = true;
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
          !equal(latest, savedValueRef.current) &&
          (!hasFailedRef.current || !equal(latest, failedValueRef.current))
        ) {
          pendingRef.current = latest;
          hasPendingRef.current = true;
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
      hasPendingRef.current = false;
      failedValueRef.current = null;
      hasFailedRef.current = false;
      return;
    }

    if (hasFailedRef.current && !equal(value, failedValueRef.current)) {
      failedValueRef.current = null;
      hasFailedRef.current = false;
    }

    const desired = desiredRef.current;
    const isSaved = equal(desired, savedValueRef.current);
    const isFailed = hasFailedRef.current && equal(desired, failedValueRef.current);

    if ((isSaved || isFailed) && !savingRef.current) {
      clearTimer();
      pendingRef.current = null;
      hasPendingRef.current = false;
      return;
    }

    // 覆盖尚未发送的旧草稿；若旧请求正在飞行，则保留这一份作为补偿提交。
    pendingRef.current = desired;
    hasPendingRef.current = true;
    clearTimer();
    timerRef.current = setTimeout(() => flushRef.current(), Math.max(0, delayMs));
    return clearTimer;
  }, [clearTimer, delayMs, enabled, flush, value]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      clearTimer();
      // 卸载前把最后一份草稿放入串行队列，避免切换页面丢设置。
      if (enabledRef.current) {
        if (savingRef.current) flushAfterUnmountRef.current = true;
        else flushRef.current();
      } else {
        pendingRef.current = null;
        hasPendingRef.current = false;
      }
    };
    // This cleanup is intentionally tied to mount/unmount, not to value changes.
  }, [clearTimer]);
}
