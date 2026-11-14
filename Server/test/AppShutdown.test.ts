import { expect, test } from "bun:test";

import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import type { AppEnv } from "../src/config/Env";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { SERVER_SHUTDOWN_MESSAGE } from "../src/shared/Index";
import { createTestApp as createApp } from "./AppFixtures";
import {
  createSocketCollector,
  openSocket,
  startTestServer,
  upgradeStatusLine,
} from "./support/AppServer";

test("系统探针 /livez 与 /readyz 正确反映就绪度与优雅停机状态", async () => {
  const env: AppEnv = {
    maintenanceToken: "test-maintenance-token",
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 4899,
    bangumiApiUrl: "https://api.bgm.tv",
    bangumiImageUrl: "",
  };
  const logger = new EventLogger();
  let shuttingDown = false;

  const whoIsFakerService = new WhoIsFakerService({ eventLogger: logger });

  const { app } = createApp({
    env,
    games: { faker: whoIsFakerService },
    logger,
    isShuttingDown: () => shuttingDown,
  });

  // 1. livez 探针始终返回 200
  const liveRes = await app.handle(new Request("http://localhost/livez"));
  expect(liveRes.status).toBe(200);
  expect(await liveRes.json()).toEqual({ status: "ok" });

  // 2. 健康状态下 readyz 返回 200
  const readyRes = await app.handle(new Request("http://localhost/readyz"));
  expect(readyRes.status).toBe(200);
  expect(await readyRes.json()).toEqual({ status: "ok", ready: true });

  // 3. 停机流程启动后 readyz 返回 503（数据库不参与就绪判定，游客游玩不依赖它）
  shuttingDown = true;
  const shuttingDownRes = await app.handle(new Request("http://localhost/readyz"));
  expect(shuttingDownRes.status).toBe(503);
  expect(await shuttingDownRes.json()).toEqual({ status: "shutting_down", ready: false });
});
test("WhoIsFakerService.notifyShutdown 会向所有在线连接广播停机通知", async () => {
  const { port, stop, whoIsFakerService } = startTestServer();

  try {
    const socket = await openSocket(port);
    const collector = createSocketCollector(socket);

    whoIsFakerService.notifyShutdown();

    const shutdownEvent = (await collector(
      (payload) =>
        (payload as { type?: string }).type === "event" &&
        (payload as { event?: string }).event === "server.shutdown"
    )) as { type: string; event: string; payload: { message: string } };

    expect(shutdownEvent.type).toBe("event");
    expect(shutdownEvent.event).toBe("server.shutdown");
    expect(shutdownEvent.payload.message).toBe(SERVER_SHUTDOWN_MESSAGE);

    socket.close();
  } finally {
    await stop();
  }
});
test("POST /api/system/notify-shutdown 拦截携带公网代理转发头的外部请求 (403 Forbidden)", async () => {
  const { port, stop } = startTestServer();

  try {
    const resWithXForwardedFor = await fetch(
      `http://127.0.0.1:${port}/api/system/notify-shutdown`,
      {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" },
      }
    );
    expect(resWithXForwardedFor.status).toBe(403);
    const json1 = (await resWithXForwardedFor.json()) as {
      error?: { code?: string; message?: string; traceId?: string };
    };
    expect(json1.error?.code).toBe("FORBIDDEN");
    expect(json1.error?.message).toContain("维护凭据");
    // 真实服务器由全局 onRequest 写入响应头，错误信封必须带上同一个追踪号，运维才能在日志里定位这一次拒绝。
    const trace1 = resWithXForwardedFor.headers.get("x-trace-id") ?? "";
    expect(trace1).not.toBe("");
    expect(json1.error?.traceId).toBe(trace1);

    const resWithXRealIp = await fetch(`http://127.0.0.1:${port}/api/system/notify-shutdown`, {
      method: "POST",
      headers: { "x-real-ip": "203.0.113.50" },
    });
    expect(resWithXRealIp.status).toBe(403);
    const json2 = (await resWithXRealIp.json()) as {
      error?: { code?: string; message?: string; traceId?: string };
    };
    expect(json2.error?.code).toBe("FORBIDDEN");
    const trace2 = resWithXRealIp.headers.get("x-trace-id") ?? "";
    expect(trace2).not.toBe("");
    expect(json2.error?.traceId).toBe(trace2);
  } finally {
    await stop();
  }
});
test("POST /api/system/notify-shutdown 缺少任何来源 IP 头时同样拒绝，且不触发停机 (fail-closed)", async () => {
  let shutdownTriggered = false;
  const { port, stop } = startTestServer({
    onTriggerShutdown: async () => {
      shutdownTriggered = true;
    },
  });

  try {
    // 直接打本机端口、不经过任何反向代理时，两个转发头都不存在。
    // 以前这会让整个校验块落空、直接触发全服停机广播。
    const res = await fetch(`http://127.0.0.1:${port}/api/system/notify-shutdown`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("FORBIDDEN");
    expect(shutdownTriggered).toBe(false);
  } finally {
    await stop();
  }
});
test("POST /api/system/notify-shutdown 本地调用成功，触发广播、探针状态切换与回调执行", async () => {
  let shutdownTriggered = false;
  const { port, stop } = startTestServer({
    onTriggerShutdown: async () => {
      shutdownTriggered = true;
    },
  });

  try {
    const socket = await openSocket(port);
    const collector = createSocketCollector(socket);

    // 初始 readyz 状态为健康 200
    const initialReady = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(initialReady.status).toBe(200);

    // 本地调用停机通知接口：运维脚本必须显式带上私网来源头，
    // fail-closed 之后缺头的请求一律按来源不可信拒绝。
    const shutdownRes = await fetch(`http://127.0.0.1:${port}/api/system/notify-shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer test-maintenance-token" },
    });
    expect(shutdownRes.status).toBe(200);
    const shutdownBody = await shutdownRes.json();
    expect(shutdownBody).toEqual({
      ok: true,
      message: "停机通知已向所有房间广播",
    });

    // 验证停机回调已触发执行
    expect(shutdownTriggered).toBe(true);

    // 验证 WebSocket 收到停机广播
    const shutdownEvent = (await collector(
      (payload) =>
        (payload as { type?: string }).type === "event" &&
        (payload as { event?: string }).event === "server.shutdown"
    )) as { type: string; event: string; payload: { message: string } };
    expect(shutdownEvent.type).toBe("event");
    expect(shutdownEvent.event).toBe("server.shutdown");
    expect(shutdownEvent.payload.message).toBe(SERVER_SHUTDOWN_MESSAGE);

    // 验证 readyz 探针立即转为 503
    const readyAfterShutdown = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(readyAfterShutdown.status).toBe(503);
    expect(await readyAfterShutdown.json()).toEqual({
      status: "shutting_down",
      ready: false,
    });

    socket.close();
  } finally {
    await stop();
  }
});
/**
 * 停机窗口内的新握手必须被直接拒绝。
 *
 * `/readyz` 回 503 只让边缘停止分配新流量，进程内的升级照样会完成 101：排空窗口因此永远
 * 等不到「没有新连接」的那一刻，刚进来的玩家会被 `app.stop(true)` 硬切断。
 * 闸门判在 Origin 白名单与握手配额之前，所以拒绝既不占配额桶，也不给来源探测留可分辨的差异。
 */
test("停机中拒绝新的 WebSocket 升级，未停机时同一入口照常放行", async () => {
  const closing = startTestServer({ isShuttingDown: () => true });
  const normal = startTestServer();

  try {
    const rejected = await upgradeStatusLine(closing.port, "http://localhost:5173");
    expect(rejected).toContain("503");

    // 闸门只认停机标志：白名单内的来源在正常态必须仍然拿到 101，否则就是把正常流量锁死了
    const allowed = await upgradeStatusLine(normal.port, "http://localhost:5173");
    expect(allowed).toContain("101");
  } finally {
    await closing.stop();
    await normal.stop();
  }
});
