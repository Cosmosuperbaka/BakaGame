const port = 4851;
const baseUrl = `http://127.0.0.1:${port}`;
const server = Bun.spawn(["bun", "run", "src/Index.ts"], {
  cwd: `${import.meta.dir}/..`,
  env: {
    ...Bun.env,
    SERVER_PORT: String(port),
    SERVER_URL: baseUrl,
    SERVER_LISTEN_HOST: "127.0.0.1",
    WORD_BANK_PATH: ":memory:",
    BANGUMI_API_URL: "http://127.0.0.1:9",
    BANGUMI_IMAGE_URL: "http://127.0.0.1:9",
  },
  stdout: "ignore",
  stderr: "ignore",
});

const waitForHealth = async (): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok && (await response.json()).status === "ok") return;
    } catch {
      // 服务进程可能仍在加载依赖，继续探活直到超时。
    }
    await Bun.sleep(200);
  }
  throw new Error("生产服务在 15 秒内未通过 /health 探活");
};

const waitForAck = (socket: WebSocket, id: string): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`等待 WebSocket ACK 超时: ${id}`));
    }, 5_000);

    const onMessage = (event: MessageEvent<string>) => {
      let packet: Record<string, unknown>;
      try {
        packet = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (packet.type !== "ack" || packet.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(packet);
    };

    socket.addEventListener("message", onMessage);
  });

const openSocket = async (path: string): Promise<WebSocket> => {
  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}${path}`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`WebSocket 打开超时: ${path}`)), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket 打开失败: ${path}`));
    }, { once: true });
  });
  return socket;
};

const assertProbe = async (path: string): Promise<void> => {
  const response = await fetch(`${baseUrl}${path}`);
  if (response.status !== 200) {
    throw new Error(`${path} 返回 ${response.status}`);
  }
  const payload = (await response.json()) as { status?: string };
  if (payload.status !== "ok") {
    throw new Error(`${path} 响应状态异常`);
  }
};

const sockets: WebSocket[] = [];
try {
  await waitForHealth();
  await assertProbe("/livez");
  await assertProbe("/readyz");

  const whoIsFaker = await openSocket("/api/whoisfaker/ws");
  sockets.push(whoIsFaker);
  const whoAckPromise = waitForAck(whoIsFaker, "smoke-who");
  whoIsFaker.send(JSON.stringify({ id: "smoke-who", type: "lobby.subscribeRooms", payload: {} }));
  const whoAck = await whoAckPromise;
  if (whoAck.requestType !== "lobby.subscribeRooms") {
    throw new Error("WhoIsFaker 订阅 ACK 类型异常");
  }

  const sonGuessr = await openSocket("/api/songuessr/ws");
  sockets.push(sonGuessr);
  const songAckPromise = waitForAck(sonGuessr, "smoke-song");
  sonGuessr.send(JSON.stringify({ id: "smoke-song", type: "song.lobby.subscribeRooms", payload: {} }));
  const songAck = await songAckPromise;
  if (songAck.requestType !== "song.lobby.subscribeRooms") {
    throw new Error("SonGuessr 订阅 ACK 类型异常");
  }

  console.log("生产服务冒烟通过: /health /livez /readyz 与双 WebSocket 订阅");
} finally {
  for (const socket of sockets) socket.close();
  server.kill("SIGTERM");
  await Promise.race([server.exited, Bun.sleep(5_000)]);
  if (!server.killed) server.kill();
}
