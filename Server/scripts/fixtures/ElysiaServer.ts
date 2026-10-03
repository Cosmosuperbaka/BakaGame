import { Elysia } from "elysia";
// 真实框架最小夹具；不导入 App/Index、不创建业务 Provider。
const app = new Elysia().get("/health", () => ({ status: "ok" })).listen({ hostname: "127.0.0.1", port: Number(Bun.env.SERVER_PORT) });
await app.modules;
app.server?.reload({ fetch: app.fetch, routes: { "/native-route": new Response("ok") } });
