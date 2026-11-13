/**
 * 把捕获到的错误变成给玩家看的一句话：协议拒绝与 Error 都带字符串 message，
 * 没有、不是字符串或只有空白时用兜底文案，toast 不会出现 undefined。
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error as { message: unknown };
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}
