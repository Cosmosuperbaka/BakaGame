import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { SonGuessrService } from "../src/application/SonGuessrService";
import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { ThreeTierRateLimiter } from "../src/infrastructure/RateLimiter";
import type { MusicProvider } from "../src/infrastructure/music/MusicProvider";
import type { AppEnv } from "../src/config/Env";
import { REAL_CLIENT_IP_HEADER } from "../src/transport/ClientIp";
import { songAudioRoutes } from "../src/transport/routes/SongAudio";
import { createTestApp } from "./AppFixtures";
import {
  audioTicketOf,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  makeSong,
  provider,
  startRound,
} from "./songuessr/Fixtures";
import type { SonGuessrPrivateState, SonGuessrRoomSnapshot } from "../src/shared/Index";

const UPSTREAM = "https://ws.stream.qqmusic.example/M500abcdefabcdef.mp3?vkey=SIGNATURE";

const env = {
  clientUrl: "http://localhost:5173",
  serverUrl: "http://localhost:4850",
  serverListenHost: "127.0.0.1",
  serverPort: 0,
  bangumiApiUrl: "https://api.bgm.tv",
  bangumiImageUrl: "",
} satisfies AppEnv;

const silentLogger = new EventLogger(() => {});

/** 真实服务开一局，返回整套应用与当前回合的票据路径。 */
const openRound = async (musicProvider: Partial<MusicProvider> = {}) => {
  const service = new SonGuessrService({
    musicProvider: {
      ...provider,
      getSong: async (id) => ({ ...makeSong(id, "答案歌", 2022), audioUrl: UPSTREAM }),
      ...musicProvider,
    },
    random: { nextInt: () => 0 },
  });
  const host = connection(service, "route-host");
  const guest = connection(service, "route-guest");
  await createRoom(service, host);
  const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
  await joinRoom(service, guest, "听众");
  await startRound(service, host, guest, hostState.playerId);
  const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
  const ticket = audioTicketOf(snapshot);
  const { app } = createTestApp({
    env,
    logger: silentLogger,
    games: { faker: new WhoIsFakerService({ eventLogger: silentLogger }), song: service },
  });
  return { app, service, host, guest, ticket, path: `/api/songuessr/audio/1234/${ticket}` };
};

const request = (
  app: { handle: (request: Request) => Promise<Response> },
  path: string,
  init: RequestInit = {}
) => app.handle(new Request(`http://localhost${path}`, { redirect: "manual", ...init }));

/**
 * 404 的比对口径：状态、响应头、规整掉追踪号后的响应体逐字节相同。
 * 追踪号与限流剩余额度是每次请求都会变的，与「房间在不在、票据对不对」无关，不参与比对。
 */
const fingerprint = async (response: Response) => {
  const headers = [...response.headers.entries()]
    .filter(([name]) => name !== "x-trace-id" && !name.startsWith("x-ratelimit-"))
    .sort(([left], [right]) => left.localeCompare(right));
  const traceId = response.headers.get("x-trace-id") ?? "";
  const body = (await response.text()).replaceAll(traceId, "<trace>");
  return JSON.stringify({ status: response.status, headers, body });
};

describe("猜歌站内播放地址路由", () => {
  test("GET 回 302 跳到服务端保存的上游地址，响应禁止缓存且带不泄露来源的策略", async () => {
    const { app, path } = await openRound();
    const response = await request(app, path);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(UPSTREAM);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // 浏览器据此在跳转之后不向上游带本站地址作为来源。
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe("");
  });

  test("HEAD 可用，与 GET 同样回跳转", async () => {
    const { app, path } = await openRound();
    const response = await request(app, path, { method: "HEAD" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(UPSTREAM);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("其它方法一律被拒，不会跳转", async () => {
    const { app, path } = await openRound();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await request(app, path, { method });
      expect([404, 405]).toContain(response.status);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  test("房间不在、回合已换、票据不符三种 404 完全相同", async () => {
    const { app, service, host, guest, path, ticket } = await openRound();
    const wrongTicket = await request(app, `/api/songuessr/audio/1234/${ticket}x`);
    const noRoom = await request(app, `/api/songuessr/audio/9999/${ticket}`);

    // 回合已换：把本回合结算掉再进入下一轮，旧票据立即失效。
    await execute(service, guest, {
      id: "ready-1",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    await execute(service, guest, {
      id: "guess-1",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    await execute(service, host, {
      id: "next",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    const staleRound = await request(app, path);

    expect(wrongTicket.status).toBe(404);
    const reference = await fingerprint(wrongTicket);
    expect(await fingerprint(noRoom)).toBe(reference);
    expect(await fingerprint(staleRound)).toBe(reference);
    expect(wrongTicket.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(reference).body).toContain("AUDIO_NOT_FOUND");
  });

  test("房间关闭后 404，且不再跳转", async () => {
    const { app, service, path } = await openRound();
    service.rooms.delete("1234");
    const response = await request(app, path);
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });

  test("请求里夹带别的地址参数不影响跳转目标", async () => {
    const { app, path } = await openRound();
    const query =
      "?url=https%3A%2F%2Fevil.example%2Fa.mp3&redirect=https://evil.example/b&to=//evil.example/c&location=https://evil.example/d";
    const response = await request(app, `${path}${query}`, {
      headers: { referer: "https://evil.example/", origin: "https://evil.example" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(UPSTREAM);
  });

  test("刷新上游地址后，重新请求同一个票据地址拿到新地址", async () => {
    const { app, service, guest, path } = await openRound({
      refreshSongAudio: async () => "https://cdn.example.net/fresh/after-refresh.mp3",
    });
    expect((await request(app, path)).headers.get("location")).toBe(UPSTREAM);
    await execute(service, guest, {
      id: "audio-failed",
      type: "song.game.audioFailed",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    const again = await request(app, path);
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe("https://cdn.example.net/fresh/after-refresh.mp3");
  });

  test("路由本身不发任何出站请求", async () => {
    const { app, path } = await openRound();
    const originalFetch = globalThis.fetch;
    let outbound = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      outbound += 1;
      return originalFetch(...args);
    }) as typeof fetch;
    try {
      await request(app, path);
      await request(app, "/api/songuessr/audio/1234/nope");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(outbound).toBe(0);
  });
});

describe("猜歌站内播放地址路由：限流与目标校验", () => {
  const source = (target: string | undefined) => ({ resolveAudioRedirect: () => target });

  test("超过额度回 429 并带限流呈现头，被拒的请求不再查表", async () => {
    let lookups = 0;
    const app = new Elysia().use(
      songAudioRoutes({
        song: {
          resolveAudioRedirect: () => {
            lookups += 1;
            return UPSTREAM;
          },
        },
        rateLimiter: new ThreeTierRateLimiter({ ipMaxRequests: 2, windowMs: 60_000 }),
      })
    );
    const get = (ip: string) =>
      app.handle(
        new Request("http://localhost/api/songuessr/audio/1234/abc", {
          headers: { [REAL_CLIENT_IP_HEADER]: ip },
        })
      );
    expect((await get("203.0.113.7")).status).toBe(302);
    expect((await get("203.0.113.7")).status).toBe(302);
    const limited = await get("203.0.113.7");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(lookups).toBe(2);
    // 别的来源不受影响。
    expect((await get("203.0.113.8")).status).toBe(302);
  });

  test("路由单独挂载时 302 自己就带禁止缓存，不依赖全局响应钩子补头", async () => {
    const app = new Elysia().use(songAudioRoutes({ song: source(UPSTREAM) }));
    const response = await app.handle(new Request("http://localhost/api/songuessr/audio/1/x"));
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("上游地址不是 http(s) 绝对地址时不跳转", async () => {
    for (const target of ["//evil.example/a.mp3", "/relative/a.mp3", "javascript:alert(1)", ""]) {
      const app = new Elysia().use(songAudioRoutes({ song: source(target) }));
      const response = await app.handle(new Request("http://localhost/api/songuessr/audio/1/x"));
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
    }
  });
});
