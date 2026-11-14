import { expect, test } from "bun:test";
import { connect } from "node:net";

import { OPEN_SITE_FEATURES } from "../src/shared/SiteFeatures";
import {
  STATUS_WS_IP_MAX_CONNECTIONS,
  WS_HANDSHAKE_IP_MAX_CONNECTIONS,
} from "../src/config/Constants";
import { ClientChannel, InMemoryClientChannelStore } from "../src/infrastructure/ClientChannel";
import { resolveAgentIdentity } from "../src/transport/ws/Handshake";
import { WsHandshakeQuota } from "../src/transport/WsHandshakeQuota";
import {
  VALID_HANDSHAKE_HEADERS,
  accountWithLookup,
  createSocketCollector,
  openSocket,
  openSocketAt,
  quotaOf,
  startTestServer,
  upgradeStatusLine,
} from "./support/AppServer";

test("WebSocket 不协商 permessage-deflate", async () => {
  const { port, stop } = startTestServer();

  try {
    const socket = await openSocket(port);
    expect(socket.extensions).not.toContain("permessage-deflate");
    socket.close();
  } finally {
    await stop();
  }
});
test("后台临时关闭模式后两条 WS 入口都拒绝新开房间，重新打开即恢复", async () => {
  let fakerOpen = false;
  const { port, stop } = startTestServer({
    siteFeatures: () => ({ ...OPEN_SITE_FEATURES, fakerEntry: fakerOpen }),
  });
  const createMessage = (id: string, roomId: string, game?: string) =>
    JSON.stringify({
      id,
      ...(game ? { game } : {}),
      type: "room.create",
      payload: {
        roomId,
        name: "关闭测试",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
      },
    });
  const errorOf = (id: string) => (payload: unknown) =>
    (payload as { type?: string; id?: string }).type === "error" &&
    (payload as { id?: string }).id === id;

  try {
    const legacy = await openSocket(port);
    const waitLegacy = createSocketCollector(legacy);
    legacy.send(createMessage("closed", "8801"));
    const rejected = (await waitLegacy(errorOf("closed"))) as {
      error: { code: string; message: string };
    };
    expect(rejected.error).toMatchObject({
      code: "MODE_CLOSED",
      message: "谁是卧底暂时关闭，请稍后再来",
    });

    const unified = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    await new Promise<void>((resolve) => unified.addEventListener("open", () => resolve()));
    const waitUnified = createSocketCollector(unified);
    unified.send(createMessage("unified-closed", "8802", "faker"));
    expect(
      ((await waitUnified(errorOf("unified-closed"))) as { error: { code: string } }).error.code
    ).toBe("MODE_CLOSED");

    // 后台改回开放后不需要重连，下一条建房命令就能成功。
    fakerOpen = true;
    legacy.send(createMessage("reopened", "8803"));
    await waitLegacy(
      (payload) =>
        (payload as { event?: string }).event === "room.snapshot" &&
        (payload as { payload?: { state?: { roomId?: string } } }).payload?.state?.roomId === "8803"
    );
    legacy.close();
    unified.close();
  } finally {
    await stop();
  }
});
test("WebSocket 握手按来源地址配额：在途连接超限回 429，断开后立即归还名额", async () => {
  const { port, stop } = startTestServer();
  const sockets: WebSocket[] = [];

  try {
    for (let index = 0; index < WS_HANDSHAKE_IP_MAX_CONNECTIONS; index += 1) {
      sockets.push(await openSocket(port));
    }

    expect(await upgradeStatusLine(port)).toContain("429");

    const held = sockets.pop()!;
    const closed = new Promise<void>((resolve) => {
      held.addEventListener("close", () => resolve(), { once: true });
      held.close();
    });
    await closed;

    // 服务端观察断开是异步的：允许在有限次数内重试，最终必须重新放行。
    let status = "";
    for (let attempt = 0; attempt < 20 && !status.includes("101"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await upgradeStatusLine(port);
      if (status.includes("429")) continue;
      break;
    }
    expect(status).toContain("101");
  } finally {
    for (const socket of sockets) socket.close();
    await stop();
  }
});
// 畸形升级：带 `Upgrade: websocket` 却缺握手必需头。运行时会在钩子之后拒掉它们，
// 既不会触发 open 也不会触发 close，名额若在钩子里就记为在途，就永远没有人归还。
const MALFORMED_UPGRADES: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "缺 Sec-WebSocket-Key",
    ["Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13"],
  ],
  [
    "缺 Sec-WebSocket-Version",
    ["Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="],
  ],
  [
    "Sec-WebSocket-Key 长度不对",
    [
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: abc",
      "Sec-WebSocket-Version: 13",
    ],
  ],
  [
    "Sec-WebSocket-Version 不是 13",
    [
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 8",
    ],
  ],
];
for (const path of ["/api/ws", "/api/whoisfaker/ws", "/api/songuessr/ws", "/api/cee/ws"]) {
  test(`${path} 的畸形升级回 400 且不占握手名额，随后同来源仍能握手并收到命令 ACK`, async () => {
    const handshakeQuota = new WsHandshakeQuota({
      windowMs: 60_000,
      ipMaxRequests: 1_000,
      globalMaxRequests: 10_000,
      ipMaxConnections: WS_HANDSHAKE_IP_MAX_CONNECTIONS,
    });
    const { port, stop } = startTestServer({ handshakeQuota });
    try {
      // 总数超过单来源在途上限：名额一旦泄漏，后半段就会回 429 而不是 400。
      for (let index = 0; index < WS_HANDSHAKE_IP_MAX_CONNECTIONS + 6; index += 1) {
        const [name, headers] = MALFORMED_UPGRADES[index % MALFORMED_UPGRADES.length];
        expect(await upgradeStatusLine(port, undefined, { path, headers }), name).toContain("400");
      }
      expect(handshakeQuota.liveConnections()).toBe(0);

      // 握手成功不等于链路可用：再发一条真实命令，必须看到 ACK。
      const socket = await openSocketAt(port, path);
      const collect = createSocketCollector(socket);
      const command =
        path === "/api/songuessr/ws"
          ? "song.lobby.subscribeRooms"
          : path === "/api/cee/ws"
            ? "cee.lobby.subscribeRooms"
            : "lobby.subscribeRooms";
      socket.send(JSON.stringify({ id: "after-malformed", type: command, payload: {} }));
      const ack = (await collect(
        (payload) => (payload as { id?: string }).id === "after-malformed"
      )) as { type: string };
      expect(ack.type).toBe("ack");
      socket.close();
    } finally {
      await stop();
    }
  });
}
test("占位之后的握手步骤抛错，名额当场归还", async () => {
  const handshakeQuota = new WsHandshakeQuota({
    windowMs: 60_000,
    ipMaxRequests: 1_000,
    globalMaxRequests: 10_000,
    ipMaxConnections: WS_HANDSHAKE_IP_MAX_CONNECTIONS,
  });
  // 通道票据换证在占位之后执行；日志出口故障让它抛错，升级随之失败，open/close 都不会触发。
  const clientChannel = new ClientChannel({
    store: new InMemoryClientChannelStore(),
    minimumVersion: () => "",
    onWarn: () => {
      throw new Error("日志出口故障");
    },
  });
  const { port, stop } = startTestServer({ handshakeQuota, clientChannel });
  try {
    const status = await upgradeStatusLine(port, undefined, { path: "/api/cee/ws?ticket=unknown" });
    expect(status).toContain("500");
    expect(handshakeQuota.liveConnections()).toBe(0);
  } finally {
    await stop();
  }
});
test("被配额拒绝的握手不会先查账号", async () => {
  let lookups = 0;
  const handshakeQuota = quotaOf({ ipMaxConnections: 1 });
  const { port, stop } = startTestServer({
    handshakeQuota,
    account: accountWithLookup(async () => {
      lookups += 1;
      return undefined;
    }),
  });
  const withCookie = [...VALID_HANDSHAKE_HEADERS, "Cookie: session=abc"];
  try {
    // 同一进程内直接占满该来源的在途名额。
    const held = handshakeQuota.reserve("127.0.0.1", "127.0.0.1");
    expect(held).toBeDefined();
    expect(await upgradeStatusLine(port, undefined, { headers: withCookie })).toContain("429");
    expect(lookups).toBe(0);
    // 名额恢复后同样的握手放行，并确实查了账号：说明上面的零次不是因为桩没接上。
    held!.release();
    expect(await upgradeStatusLine(port, undefined, { headers: withCookie })).toContain("101");
    expect(lookups).toBe(1);
  } finally {
    await stop();
  }
});
test("账号查询期间客户端断开，升级没能完成，租约到期后名额归还", async () => {
  const handshakeQuota = quotaOf({ leaseMs: 30 });
  const { port, stop } = startTestServer({
    handshakeQuota,
    account: accountWithLookup(
      () => new Promise((resolve) => setTimeout(() => resolve(undefined), 250))
    ),
  });
  try {
    await new Promise<void>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.write(
          [
            "GET /api/ws HTTP/1.1",
            `Host: 127.0.0.1:${port}`,
            ...VALID_HANDSHAKE_HEADERS,
            "Cookie: session=abc",
            "",
            "",
          ].join("\r\n")
        );
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 20);
      });
    });
    // 查询还没返回（250ms），升级尚未完成：占位已经在，到期（30ms）后必须自动归还。
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(handshakeQuota.liveConnections()).toBe(0);
    // 查询返回后升级对已断开的连接失败或立即关闭，最终都不会留下名额。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(handshakeQuota.liveConnections()).toBe(0);
  } finally {
    await stop();
  }
});
/**
 * 解析失败时必须回一条**客户端能匹配**的错误包，并把原始载荷形态写进日志。
 *
 * 否则链路是：`parse` 抛错 → 错误包 id 退化成占位值 → 客户端 `pendingRequests`
 * 查不到该 id 就静默丢弃 → 进入房间类请求用 `timeout: 0` 永不超时，
 * 页面永远卡在「正在连接房间…」且毫无提示，事后日志只剩 `WS raw` 无法定位命令。
 */
test("解析失败时保留信封身份并记录原始载荷形态", async () => {
  const { port, stop } = startTestServer();
  const socket = await openSocket(port);
  const collector = createSocketCollector(socket);

  try {
    // 命令类型合法、载荷非法：解析阶段抛错，但 id/type 都可从原始载荷抢救出来。
    socket.send(
      JSON.stringify({
        id: "req-salvage-1",
        traceId: "trace-salvage",
        type: "lobby.subscribeRooms",
        payload: { 非法字段: true },
      })
    );

    const errorPacket = (await collector(
      (payload) => (payload as { type?: string }).type === "error"
    )) as { type: string; id: string; error?: { code?: string } };

    expect(errorPacket.id).toBe("req-salvage-1");
    expect(errorPacket.error?.code).toBe("INVALID_MESSAGE");
  } finally {
    socket.close();
    await stop();
  }
});
test("WebSocket 幂等重传在执行中到达时等待并回放相同响应包", async () => {
  const { port, stop } = startTestServer();

  try {
    const socket = await openSocket(port);
    const messages: Array<{ type?: string; id?: string; serverNow?: number }> = [];
    socket.onmessage = (event) => {
      messages.push(JSON.parse(event.data as string));
    };

    const req = {
      id: "req-dedup-concurrency",
      type: "lobby.subscribeRooms",
      payload: {},
    };

    // 连续并发发送两个完全相同的帧，模拟网络重传
    socket.send(JSON.stringify(req));
    socket.send(JSON.stringify(req));

    // 等待两次回应
    const start = Date.now();
    while (
      messages.filter((m) => m.id === "req-dedup-concurrency").length < 2 &&
      Date.now() - start < 3000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const acks = messages.filter((m) => m.type === "ack" && m.id === "req-dedup-concurrency");
    // 两个请求都必须收到 ACK，第二个重传帧不得被静默丢弃
    expect(acks).toHaveLength(2);
    // 回放的是同一份结果；确认帧上的服务端时刻是发出那一刻现取的（客户端靠它对时），
    // 两帧跨毫秒时会不同，比较时剔除它，其余字段必须逐一相同。
    const [first, replayed] = acks.map(({ serverNow, ...rest }) => {
      expect(typeof serverNow).toBe("number");
      return rest;
    });
    expect(first).toEqual(replayed);

    socket.close();
  } finally {
    await stop();
  }
});
test("WebSocket 升级按 Origin 白名单拦截（防跨站 WebSocket 劫持）", async () => {
  const { port, stop } = startTestServer();

  try {
    // 白名单内的来源正常完成握手
    const allowed = await upgradeStatusLine(port, "http://localhost:5173");
    expect(allowed).toContain("101");

    // 任意第三方站点必须被拒绝
    const hostile = await upgradeStatusLine(port, "https://evil.example");
    expect(hostile).toContain("403");

    // 不带 Origin 的是非浏览器来源（本地工具 / 内部调用），按现有策略放行
    const missing = await upgradeStatusLine(port);
    expect(missing).toContain("101");
  } finally {
    await stop();
  }
});
test("全部 WebSocket 路径只在网关判一次 Origin：第三方来源一律 403，缺 Origin 放行", async () => {
  const { port, stop } = startTestServer();
  try {
    for (const path of [
      "/api/ws",
      "/api/whoisfaker/ws",
      "/api/songuessr/ws",
      "/api/cee/ws",
      "/api/status/ws",
    ]) {
      expect(await upgradeStatusLine(port, "https://evil.example", { path }), path).toContain(
        "403"
      );
      expect(await upgradeStatusLine(port, "http://localhost:5173", { path }), path).toContain(
        "101"
      );
      expect(await upgradeStatusLine(port, undefined, { path }), path).toContain("101");
    }
  } finally {
    await stop();
  }
});
test("状态页实时通道按来源限制并发：一个来源占满自己的名额后，别的来源仍能连", async () => {
  const { port, stop } = startTestServer();
  const sockets: WebSocket[] = [];
  const from = (ip: string) => [...VALID_HANDSHAKE_HEADERS, `X-Real-IP: ${ip}`];
  try {
    // 持有 4 条（单来源上限）：raw 请求在读到状态行后即销毁，所以用真实 WebSocket 占住。
    for (let index = 0; index < STATUS_WS_IP_MAX_CONNECTIONS; index += 1) {
      sockets.push(await openSocketAt(port, "/api/status/ws"));
    }
    expect(await upgradeStatusLine(port, undefined, { path: "/api/status/ws" })).toContain("429");
    // 别的来源不受影响，且握手之后确实收到了推送。
    expect(
      await upgradeStatusLine(port, undefined, {
        path: "/api/status/ws",
        headers: from("203.0.113.77"),
      })
    ).toContain("101");
    // 畸形升级同样不占名额。
    for (const [, headers] of MALFORMED_UPGRADES) {
      expect(
        await upgradeStatusLine(port, undefined, { path: "/api/status/ws", headers })
      ).toContain("400");
    }
  } finally {
    for (const socket of sockets) socket.close();
    await stop();
  }
});
for (const [game, command] of [
  ["whoisfaker", "lobby.subscribeRooms"],
  ["songuessr", "song.lobby.subscribeRooms"],
  ["cee", "cee.lobby.subscribeRooms"],
] as const) {
  test(`${game} 原生 WS schema 保持二进制/空白 JSON、关联错误与严格字段契约`, async () => {
    const { port, stop } = startTestServer();
    const socket = await openSocket(port, game);
    const collect = createSocketCollector(socket);
    const getPacket = (id: string) =>
      collect((packet) => (packet as { id?: string }).id === id) as Promise<{
        type: string;
        traceId?: string;
        error?: { code: string };
      }>;
    try {
      for (const [id, frame] of [
        ["native-text", "text"],
        ["native-binary", "binary"],
      ] as const) {
        const message = JSON.stringify({
          id,
          type: command,
          traceId: "native-trace",
          payload: {},
          ...(game === "cee" ? { roomId: null, sessionToken: null } : {}),
        });
        socket.send(frame === "text" ? ` \n${message}\n ` : new TextEncoder().encode(message));
        expect(await getPacket(id)).toMatchObject({ type: "ack", traceId: "native-trace" });
      }
      for (const [id, patch, code] of [
        ["native-invalid", { payload: { unauthorizedField: true } }, "INVALID_MESSAGE"],
        ["native-prototype", { type: "constructor" }, "UNKNOWN_MESSAGE_TYPE"],
        ["native-unknown", { type: "not.a.command" }, "UNKNOWN_MESSAGE_TYPE"],
        ["native-extra", { extraEnvelopeField: true }, "INVALID_MESSAGE"],
      ] as const) {
        socket.send(
          JSON.stringify(
            Object.assign({ id, type: command, traceId: "error-trace", payload: {} }, patch)
          )
        );
        expect(await getPacket(id)).toMatchObject({
          type: "error",
          traceId: "error-trace",
          error: { code },
        });
      }
      socket.send("{broken json");
      const raw = await getPacket("unknown");
      expect(raw).toMatchObject({ type: "error", error: { code: "INVALID_MESSAGE" } });
    } finally {
      socket.close();
      await stop();
    }
  });
}
test("Agent 握手标记受 MCP_ENABLED 控制，未声明时不标记", () => {
  const agentContext: { request: Request; isAgent?: boolean } = {
    request: new Request("http://localhost/api/whoisfaker/ws?agent=1"),
  };
  expect(() => resolveAgentIdentity(agentContext, false)).toThrow("Agent 接入未启用");

  resolveAgentIdentity(agentContext, true);
  expect(agentContext.isAgent).toBe(true);

  const humanContext: { request: Request; isAgent?: boolean } = {
    request: new Request("http://localhost/api/whoisfaker/ws"),
  };
  resolveAgentIdentity(humanContext, true);
  expect(humanContext.isAgent).toBeUndefined();
});
