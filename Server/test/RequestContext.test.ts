import { expect, test } from "bun:test";
import { Elysia } from "elysia";

import { REAL_CLIENT_IP_HEADER } from "../src/transport/ClientIp";
import { requestContext } from "../src/transport/RequestContext";

/** 路由插件各自 `.use` 请求上下文：派生值必须落到使用它的那一层路由上。 */
const appUnderTest = () =>
  new Elysia()
    .use(
      new Elysia({ name: "consumer" })
        .use(requestContext)
        .get("/who", ({ peerIp, clientIp }) => ({ peerIp: peerIp ?? null, clientIp }))
    )
    .get("/outside", (context) => ({ visible: "clientIp" in context }));

test("请求上下文给出真实来源与对端地址：可信标头优先，缺失时退回对端", async () => {
  const app = appUnderTest();
  const trusted = await app.handle(
    new Request("http://localhost/who", { headers: { [REAL_CLIENT_IP_HEADER]: "203.0.113.7" } })
  );
  expect(await trusted.json()).toEqual({ peerIp: null, clientIp: "203.0.113.7" });
  // 非 IP 字面量不被采信：否则客户端能用随机值给自己发新的限流桶。
  const forged = await app.handle(
    new Request("http://localhost/who", { headers: { [REAL_CLIENT_IP_HEADER]: "not-an-ip" } })
  );
  expect(await forged.json()).toEqual({ peerIp: null, clientIp: "unknown" });
});

test("请求上下文只对使用它的插件可见，不泄漏给无关路由", async () => {
  const response = await appUnderTest().handle(new Request("http://localhost/outside"));
  expect(await response.json()).toEqual({ visible: false });
});
