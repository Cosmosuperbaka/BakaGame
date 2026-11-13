import { Elysia } from "elysia";

import { resolveClientIp } from "./ClientIp";

/**
 * 每个请求的来源地址：`peerIp` 是 socket 对端（边缘反代后恒为边缘节点），`clientIp` 是按可信标头
 * 解析出的真实来源，限流桶与日志身份取后者。
 *
 * 路由插件各自是独立实例，拿不到父实例的派生值，所以每个要读来源的插件自己 `.use` 本插件：
 * 同名插件只装一次，作用域取 `scoped`，只对使用它的那一层可见。
 */
export const requestContext = new Elysia({ name: "request-context" }).derive(
  { as: "scoped" },
  ({ request, server }) => {
    const peerIp = server?.requestIP(request)?.address;
    return { peerIp, clientIp: resolveClientIp(request.headers, peerIp) };
  }
);
