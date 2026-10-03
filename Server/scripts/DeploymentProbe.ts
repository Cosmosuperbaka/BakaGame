/** 只读发布探针；不加载应用、凭据或第三方 Provider。 */
export interface DeploymentProbeIO {
  fetch: typeof globalThis.fetch;
  now: () => number;
  sleep: (milliseconds: number) => Promise<unknown>;
}
export async function probeDeployment(baseUrl = "http://127.0.0.1:4850", budgetMs = 30_000, signal?: AbortSignal,
  io: DeploymentProbeIO = { fetch: globalThis.fetch, now: Date.now, sleep: Bun.sleep },
): Promise<void> {
  const deadline = io.now() + budgetMs;
  const remaining = () => Math.max(1, Math.min(5_000, deadline - io.now()));
  for (;;) {
    signal?.throwIfAborted();
    try {
      for (const path of ["/health", "/livez", "/readyz"]) {
        const response = await io.fetch(`${baseUrl}${path}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(remaining())]) : AbortSignal.timeout(remaining()) });
        const body = await response.json() as { status?: string; ready?: boolean };
        if (!response.ok || body.status !== "ok" || (path === "/readyz" && body.ready !== true)) {
          throw new Error(`业务探针失败: ${path}`);
        }
      }
      const results = await Promise.allSettled([
        ["/api/whoisfaker/ws", "lobby.subscribeRooms"],
        ["/api/songuessr/ws", "song.lobby.subscribeRooms"],
        ["/api/ccb/ws", "ccb.lobby.subscribeRooms"],
      ].map(([path, requestType]) => new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}${path}`);
        const id = crypto.randomUUID();
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          socket.close();
          error ? reject(error) : resolve();
        };
        const onAbort = () => finish(new Error("部署探针已取消"));
        signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => finish(new Error(`订阅 ACK 超时: ${path}`)), remaining());
        socket.addEventListener("open", () => socket.send(JSON.stringify({ id, type: requestType, payload: {} })), { once: true });
        socket.addEventListener("error", () => finish(new Error(`协议连接失败: ${path}`)), { once: true });
        socket.addEventListener("close", () => finish(new Error(`协议提前关闭: ${path}`)), { once: true });
        socket.addEventListener("message", event => {
          let packet: { id?: string; type?: string; requestType?: string };
          try { packet = JSON.parse(String(event.data)); } catch { return; }
          if (packet.id !== id) return;
          if (packet.type !== "ack" || packet.requestType !== requestType) return finish(new Error(`订阅 ACK 无效: ${path}`));
          finish();
        });
      })));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      return;
    } catch (error) {
      signal?.throwIfAborted();
      if (io.now() >= deadline) throw error;
      await io.sleep(Math.min(200, deadline - io.now()));
    }
  }
}

if (import.meta.main) {
  await probeDeployment();
  console.log("业务就绪通过: /health /livez /readyz 与三个订阅 ACK");
}
