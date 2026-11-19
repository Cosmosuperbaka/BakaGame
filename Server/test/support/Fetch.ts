/** 测试用 fetch 假实现：Bun 的全局 fetch 还带 `preconnect`，直接写函数对象补不齐。 */
export const fakeFetch = (
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>
): typeof fetch =>
  Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(input, init)),
    { preconnect: () => {} }
  );
