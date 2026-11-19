/**
 * 把捕获到的错误变成给玩家看的一句话：协议拒绝与 Error 都带字符串 message，
 * 没有、不是字符串或只有空白时用兜底文案，toast 不会出现 undefined。
 */
export function errorText(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

/** 带字符串 code 的对象给出错误码，其余捕获值一律 undefined，调用方按码分支不必再强转。 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** 入房事务取消抛的是 AbortError；只认 name，不认 message 文案。 */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}
