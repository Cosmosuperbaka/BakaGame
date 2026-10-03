import "./IsolatedPreload";

// Windows smoke 的测试专属入口：调用已注册 listener，而非伪称 OS 投递 SIGTERM。
// 不进入生产代码；继续继承 IsolatedPreload 的出口与 Worker 守卫。
const owner = Bun.env.BAKAGAME_TEST_OWNER;
if (!owner) throw new Error("停机 smoke 缺少自有进程标识");
const signalRoute = {
  "/__bakagame_test_signal": (request: Request) => {
    if (request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${owner}`) {
      return new Response("Forbidden", { status: 403 });
    }
    queueMicrotask(() => {
      process.emit("SIGTERM");
      process.emit("SIGTERM");
      process.emit("SIGINT");
    });
    return Response.json({ delivery: "process.emit", signals: ["SIGTERM", "SIGTERM", "SIGINT"] });
  },
};
const serve = Bun.serve;
Bun.serve = <Data = undefined, R extends string = never>(options: Bun.Serve.Options<Data, R>): Bun.Server<Data> => {
  const server = serve<Data, R>(Object.assign({}, options, {
    routes: Object.assign({}, options.routes, signalRoute),
  }));
  const reload = server.reload.bind(server);
  server.reload = <Route extends string = never>(options: Bun.Serve.Options<Data, Route>) => reload<Route>(Object.assign({}, options, {
    routes: Object.assign({}, options.routes, signalRoute),
  }));
  return server;
};
