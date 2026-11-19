/**
 * 给上游 Promise 加一个上界：到点后以 `onTimeout` 的结果结算（它抛错即拒绝）。
 *
 * 超时后原 Promise 仍可能完成或拒绝，必须提前挂 `catch`，否则迟到的拒绝会变成
 * unhandledRejection（Bun 会直接终止进程）。计时器 unref，等待本身不拖住进程退出。
 */
export async function raceWithTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  void task.catch(() => {});
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
