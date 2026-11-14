/**
 * 跨线程错误上下文。
 *
 * `postMessage` 用结构化克隆，Error 的 `stack` / `name` / `cause` 都过不去：主线程
 * 收到失败后只能 `new Error(...)`，拿到的是「请求侧栈」，worker 里真正的抛出点整条
 * 丢失，Sentry 上无法归因到哪个操作、哪一行。这里显式把错误摊平成纯字符串字段，
 * cause 链按层递归但限深（防止环状引用把克隆打爆）。
 */
export interface BangumiErrorContext {
  name: string;
  message: string;
  /** worker 线程侧的栈，帧里带 worker 自己的文件名与行号。 */
  stack?: string;
  cause?: BangumiErrorContext;
}

/** 只到三层：再深的 cause 链对排障没有增量，却有把克隆图撑爆的风险。 */
const MAX_ERROR_CAUSE_DEPTH = 3;

/** 非 Error 的抛出值与 cause 可能是 Symbol、循环对象：取值本身不能让日志再抛一次。 */
const describeUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "symbol" || typeof value === "bigint") return value.toString();
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export const toErrorContext = (error: unknown, depth = 0): BangumiErrorContext => {
  const thrown = error instanceof Error;
  const cause = thrown ? error.cause : undefined;
  return {
    name: thrown ? error.name : "NonErrorThrown",
    message: thrown ? error.message : describeUnknown(error),
    ...(thrown && error.stack ? { stack: error.stack } : {}),
    ...(cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH
      ? { cause: toErrorContext(cause, depth + 1) }
      : {}),
  };
};
