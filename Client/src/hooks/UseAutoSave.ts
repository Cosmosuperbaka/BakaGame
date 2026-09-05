import { useCallback, useEffect, useRef } from "react";
import equal from "fast-deep-equal";

interface AutoSaveOptions {
  delayMs?: number;
  enabled?: boolean;
  onError?: (error: unknown) => void;
}

/**
 * 文本输入防抖、显式串行保存队列。
 * 纯 Effect 驱动，严禁在渲染阶段读写 ref。
 */
export function useAutoSave<T>(
  value: T,
  save: (value: T) => Promise<unknown>,
  options: AutoSaveOptions = {},
) {
  const { delayMs = 400, enabled = true, onError } = options;

  const callbacksRef = useRef({ save, onError, delayMs, enabled });
  const isMountedRef = useRef(true);
  const savedValueRef = useRef<T>(value);
  const pendingValueRef = useRef<{ value: T } | null>(null);
  const failedValueRef = useRef<{ value: T } | null>(null);
  const isSavingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processQueueRef = useRef<() => void>(() => {});

  // 在提交阶段同步最新的配置与回调引用，杜绝在 render 阶段访问或写入 ref
  useEffect(() => {
    callbacksRef.current = { save, onError, delayMs, enabled };
  });

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 显式串行保存队列处理器
  const processQueue = useCallback(() => {
    clearTimer();
    const { save: currentSave, onError: currentOnError, enabled: currentEnabled } = callbacksRef.current;

    // 若当前未启用或上一个保存仍未返回，保持等待
    if (!currentEnabled || isSavingRef.current) return;

    if (!pendingValueRef.current) return;
    const targetValue = pendingValueRef.current.value;

    // 若与已成功保存的值深度一致，或与上次失败的值相同且未重新编辑，则丢弃
    if (
      equal(targetValue, savedValueRef.current) ||
      (failedValueRef.current && equal(targetValue, failedValueRef.current.value))
    ) {
      pendingValueRef.current = null;
      return;
    }

    pendingValueRef.current = null;
    isSavingRef.current = true;

    void Promise.resolve(currentSave(targetValue))
      .then(() => {
        savedValueRef.current = targetValue;
        failedValueRef.current = null;
      })
      .catch((error) => {
        failedValueRef.current = { value: targetValue };
        currentOnError?.(error);
      })
      .finally(() => {
        isSavingRef.current = false;
        // 保存完成后，若飞行期间产生了新草稿，接力排期或立即执行
        if (callbacksRef.current.enabled && pendingValueRef.current) {
          const nextTarget = pendingValueRef.current.value;
          if (
            !equal(nextTarget, savedValueRef.current) &&
            (!failedValueRef.current || !equal(nextTarget, failedValueRef.current.value))
          ) {
            if (isMountedRef.current) {
              clearTimer();
              timerRef.current = setTimeout(
                () => processQueueRef.current(),
                Math.max(0, callbacksRef.current.delayMs),
              );
            } else {
              processQueueRef.current();
            }
            return;
          }
          pendingValueRef.current = null;
        }
      });
  }, [clearTimer]);

  useEffect(() => {
    processQueueRef.current = processQueue;
  }, [processQueue]);

  // 监听值变化与启用状态
  useEffect(() => {
    if (!enabled) {
      clearTimer();
      pendingValueRef.current = null;
      failedValueRef.current = null;
      return;
    }

    // 检查实质内容是否与已保存值或上一次失败值相同
    const isSaved = equal(value, savedValueRef.current);
    const isFailed = failedValueRef.current ? equal(value, failedValueRef.current.value) : false;

    if (isSaved || isFailed) {
      clearTimer();
      pendingValueRef.current = null;
      return;
    }

    pendingValueRef.current = { value };
    clearTimer();
    timerRef.current = setTimeout(processQueue, Math.max(0, delayMs));

    return clearTimer;
  }, [clearTimer, delayMs, enabled, processQueue, value]);

  // 组件卸载阶段刷新最新草稿
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearTimer();
      if (callbacksRef.current.enabled && pendingValueRef.current) {
        processQueueRef.current();
      }
    };
  }, [clearTimer]);
}
