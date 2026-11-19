/**
 * 测试桩里的 fetch 取文本工具。
 *
 * `String(input)` / `String(init.body)` 会把 Request、ReadableStream 之类的对象打成
 * `[object Object]`，断言只在字符串入参时才成立；这里按类型分支显式取文本，
 * 非字符串的请求体一律按空串（生产调用只会传 JSON 字符串）。
 */

export const requestUrlText = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

export const requestBodyText = (init?: RequestInit | null): string =>
  typeof init?.body === "string" ? init.body : "";
