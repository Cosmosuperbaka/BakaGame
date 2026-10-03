import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import http2 from "node:http2";
import childProcess from "node:child_process";

// 仅供隔离测试 preload。全部主动网络出口硬拒绝（含回环）；入站 Bun.serve 保留。
const denied = (): never => { throw new Error("隔离测试禁止主动网络出口"); };
globalThis.fetch = Object.assign(denied, { preconnect: denied });
globalThis.WebSocket = new Proxy(WebSocket, { construct: denied });
net.Socket.prototype.connect = denied;
http.request = denied;
http.get = denied;
https.request = denied;
https.get = denied;
tls.connect = denied;
dns.lookup = Object.assign(denied, { __promisify__: denied });
dns.resolve = Object.assign(denied, { __promisify__: denied });
dns.promises.lookup = denied;
dns.promises.resolve = denied;
// 解析器的细分方法也可能自行发包，不可只拦 lookup/resolve 总入口。
const dnsMethods = ["lookupService", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"];
for (const key of dnsMethods) {
  Reflect.set(dns, key, denied);
  Reflect.set(dns.promises, key, denied);
  Reflect.set(dns.Resolver.prototype, key, denied);
  Reflect.set(dns.promises.Resolver.prototype, key, denied);
}
Reflect.set(dns.Resolver.prototype, "resolve", denied);
Reflect.set(dns.promises.Resolver.prototype, "resolve", denied);
// Bun Resolver 在实例上绑定方法，prototype 替换不足以接管这些 own properties。
dns.Resolver = class extends dns.Resolver {
  constructor(...args: ConstructorParameters<typeof dns.Resolver>) {
    super(...args);
    for (const key of [...dnsMethods, "resolve"]) Reflect.set(this, key, denied);
  }
};
dns.promises.Resolver = class extends dns.promises.Resolver {
  constructor(...args: ConstructorParameters<typeof dns.promises.Resolver>) {
    super(...args);
    for (const key of [...dnsMethods, "resolve"]) Reflect.set(this, key, denied);
  }
};
dgram.Socket.prototype.send = denied;
Bun.connect = denied;
Bun.udpSocket = denied;
http2.connect = denied;
childProcess.spawn = denied;
childProcess.spawnSync = denied;
childProcess.exec = Object.assign(denied, { __promisify__: denied });
childProcess.execFile = Object.assign(denied, { __promisify__: denied });
childProcess.execSync = denied;
childProcess.execFileSync = denied;
childProcess.fork = denied;
Bun.spawn = denied;
Bun.spawnSync = denied;

// Bangumi Provider 使用 Worker；每个 Worker 必须继承同一守卫，不让跨线程 fetch 绕开隔离。
globalThis.Worker = class extends Worker {
  constructor(script: string | URL, options: WorkerOptions = {}) {
    const preloads = options.preload === undefined ? [] : typeof options.preload === "string" ? [options.preload] : options.preload;
    super(script, { ...options, preload: [...preloads, import.meta.path] });
  }
};

// 所有者端点仅存在于测试 preload。覆盖原生 routes 与 reload，保留生产 fetch/WS 原样。
const ownerRoute = {
  "/__bakagame_test_owner": new Response(Bun.env.BAKAGAME_TEST_OWNER ?? "", {
    headers: { "cache-control": "no-store" },
  }),
};
const serve = Bun.serve;
Bun.serve = <Data = undefined, R extends string = never>(options: Bun.Serve.Options<Data, R>): Bun.Server<Data> => {
  const server = serve<Data, R>(Object.assign({}, options, {
    routes: Object.assign({}, options.routes, ownerRoute),
  }));
  const reload = server.reload.bind(server);
  server.reload = <Route extends string = never>(options: Bun.Serve.Options<Data, Route>) => reload<Route>(Object.assign({}, options, {
    routes: Object.assign({}, options.routes, ownerRoute),
  }));
  return server;
};
