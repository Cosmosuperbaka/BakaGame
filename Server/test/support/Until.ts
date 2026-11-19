export interface UntilOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * 有界轮询：条件成立就返回它的值，超时抛出带 label 的错误。
 * 用于「后台任务稍后落库」这类异步结果，避免用例整段挂到套件超时。
 */
export const until = async <T>(
  label: string,
  probe: () => T | false | null | undefined | Promise<T | false | null | undefined>,
  { timeoutMs = 4_000, intervalMs = 10 }: UntilOptions = {}
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== false && value !== null && value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`${label}：等待 ${timeoutMs}ms 仍未成立`);
    }
    await Bun.sleep(intervalMs);
  }
};
