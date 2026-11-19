import { describe, expect, test } from "bun:test";

import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  ANIME_SONGS_QUOTA_COST,
  MUSIC_AUTH_RATE_LIMIT_PER_CONNECTION,
  MUSIC_AUTH_RATE_LIMIT_WINDOW_MS,
  MUSIC_RATE_LIMIT_PER_CONNECTION,
  MUSIC_RATE_LIMIT_WINDOW_MS,
  SUBJECT_IMAGE_RATE_LIMIT_PER_CONNECTION,
  SUBJECT_IMAGE_RATE_LIMIT_WINDOW_MS,
} from "../../src/application/songuessr/Records";
import {
  COMMAND_RATE_LIMIT_PER_CONNECTION,
  COMMAND_RATE_LIMIT_WINDOW_MS,
} from "../../src/config/Constants";
import { fakeBangumiProvider } from "../support/Providers";
import type { SonGuessrClientMessage } from "../../src/shared/Index";
import {
  anime,
  connection,
  createRoom,
  execute,
  joinRoom,
  provider,
  type TestConnection,
} from "./Fixtures";

// 每条连接的命令总额度，加上猜歌里会打上游的几类命令各自的配额：
// 番剧取歌按成本扣多份、番剧封面独立限流、三条音乐登录命令按连接限流。

const bangumi = fakeBangumiProvider({
  getSubject: async () => anime,
  searchSubjects: async () => [],
  resolveSubjectImage: async () => "https://img.example/cover.jpg",
});

const loginProvider = {
  ...provider,
  createQrLogin: async () => ({ key: "qr-key", qrUrl: "https://example.com/qr", qrImage: "" }),
  checkQrLogin: async () => ({ status: "waiting" as const, message: "等待扫码" }),
};

const setup = async () => {
  let clock = 1_000_000;
  const service = new SonGuessrService({
    musicProvider: loginProvider,
    bangumiProvider: bangumi,
    now: () => clock,
  });
  const host = connection(service, "q-host");
  const guest = connection(service, "q-guest");
  await createRoom(service, host);
  await joinRoom(service, guest, "访客");
  /** 发命令，返回错误码（成功返回 "ok"）。 */
  const send = async (
    who: TestConnection,
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<string> => {
    try {
      await execute(service, who, {
        id: "q",
        type,
        roomId: "1234",
        payload,
      } as SonGuessrClientMessage);
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? "unknown";
    }
  };
  // 建房与加入各占一份总额度；窗口推过去再开始计，让每条用例从满额度起算。
  clock += Math.max(COMMAND_RATE_LIMIT_WINDOW_MS, MUSIC_RATE_LIMIT_WINDOW_MS) + 1;
  return {
    service,
    host,
    guest,
    send,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
};

describe("额度取值的依据（上下界钉住：放宽或收紧到误伤、失效都要先改这里）", () => {
  test("番剧取歌：成本大于一份，整桶仍够一名出题人一分钟翻看至少 4 部番剧", () => {
    expect(ANIME_SONGS_QUOTA_COST).toBeGreaterThan(1);
    expect(
      Math.floor(MUSIC_RATE_LIMIT_PER_CONNECTION / ANIME_SONGS_QUOTA_COST)
    ).toBeGreaterThanOrEqual(4);
  });

  test("番剧封面：不小于一次搜索的整屏封面（20 部），不超过三屏", () => {
    expect(SUBJECT_IMAGE_RATE_LIMIT_PER_CONNECTION).toBeGreaterThanOrEqual(20);
    expect(SUBJECT_IMAGE_RATE_LIMIT_PER_CONNECTION).toBeLessThanOrEqual(60);
  });

  test("音乐登录：容得下每 2 秒一次的轮询（每分钟 30 次）加换码余量，不超过 60", () => {
    expect(MUSIC_AUTH_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(MUSIC_AUTH_RATE_LIMIT_PER_CONNECTION).toBeGreaterThanOrEqual(36);
    expect(MUSIC_AUTH_RATE_LIMIT_PER_CONNECTION).toBeLessThanOrEqual(60);
  });
});

describe("番剧取歌按成本扣多份", () => {
  test("一次扣多份：整桶只够若干次，满了回 RATE_LIMITED，窗口过后恢复", async () => {
    const { host, send, advance } = await setup();
    const allowed = Math.floor(MUSIC_RATE_LIMIT_PER_CONNECTION / ANIME_SONGS_QUOTA_COST);
    for (let index = 0; index < allowed; index += 1) {
      expect(await send(host, "song.bangumi.songs", { subjectId: "1" })).not.toBe("RATE_LIMITED");
      advance(1_000);
    }
    expect(await send(host, "song.bangumi.songs", { subjectId: "1" })).toBe("RATE_LIMITED");
    advance(MUSIC_RATE_LIMIT_WINDOW_MS + 1);
    expect(await send(host, "song.bangumi.songs", { subjectId: "1" })).not.toBe("RATE_LIMITED");
  });

  test("与检索共用音乐额度：取过番剧歌后检索可用的次数相应减少", async () => {
    const { host, send, advance } = await setup();
    expect(await send(host, "song.bangumi.songs", { subjectId: "1" })).not.toBe("RATE_LIMITED");
    const left = MUSIC_RATE_LIMIT_PER_CONNECTION - ANIME_SONGS_QUOTA_COST;
    for (let index = 0; index < left; index += 1) {
      expect(await send(host, "song.music.search", { keyword: "a" })).toBe("ok");
      advance(1_000);
    }
    expect(await send(host, "song.music.search", { keyword: "a" })).toBe("RATE_LIMITED");
  });

  test("旁观者不能借房内账号取番剧歌，也不耗额度", async () => {
    const { service, guest, send } = await setup();
    const seat = Object.values(service.rooms.get("1234")!.players).find((p) => p.name === "访客")!;
    seat.membership = "spectator";
    for (let index = 0; index < 10; index += 1)
      expect(await send(guest, "song.bangumi.songs", { subjectId: "1" })).toBe(
        "SPECTATOR_FORBIDDEN"
      );
  });
});

describe("番剧封面独立限流", () => {
  test("满额度放行，多一条回 RATE_LIMITED，窗口过后恢复；不占音乐额度", async () => {
    const { host, send, advance } = await setup();
    for (let index = 0; index < SUBJECT_IMAGE_RATE_LIMIT_PER_CONNECTION; index += 1) {
      expect(await send(host, "song.subject.image", { subjectId: "1" })).toBe("ok");
      // 每 10 秒一段推进，避免撞到总额度（那是另一道闸）。
      if ((index + 1) % COMMAND_RATE_LIMIT_PER_CONNECTION === 0)
        advance(COMMAND_RATE_LIMIT_WINDOW_MS - 1);
    }
    expect(await send(host, "song.subject.image", { subjectId: "1" })).toBe("RATE_LIMITED");
    // 封面额度用完不影响搜歌。
    expect(await send(host, "song.music.search", { keyword: "a" })).toBe("ok");
    advance(SUBJECT_IMAGE_RATE_LIMIT_WINDOW_MS + 1);
    expect(await send(host, "song.subject.image", { subjectId: "1" })).toBe("ok");
  });

  test("一次搜索的整屏封面（二十部）连续补齐不会被限", async () => {
    const { host, send } = await setup();
    for (let index = 0; index < 20; index += 1)
      expect(await send(host, "song.subject.image", { subjectId: String(index) })).toBe("ok");
  });
});

describe("音乐登录命令按连接限流", () => {
  test("二维码创建、轮询与凭据登录共用登录额度，满了回 RATE_LIMITED，窗口过后恢复", async () => {
    const { guest, send, advance } = await setup();
    const sequence = ["song.auth.qr.create", "song.auth.qr.check", "song.auth.useCookie"] as const;
    const payloadOf = (type: (typeof sequence)[number]): Record<string, unknown> =>
      type === "song.auth.qr.check"
        ? { key: "qr-key" }
        : type === "song.auth.useCookie"
          ? { cookie: "MUSIC_U=guest-cookie" }
          : {};
    // 登录额度的窗口是 60 秒：发送之间每 40 条推进一个总额度窗口，避免撞到总额度（那是另一道闸）。
    let sent = 0;
    while (sent < MUSIC_AUTH_RATE_LIMIT_PER_CONNECTION) {
      const type = sequence[sent % sequence.length];
      expect(await send(guest, type, payloadOf(type))).not.toBe("RATE_LIMITED");
      sent += 1;
      if (sent % 40 === 0) advance(COMMAND_RATE_LIMIT_WINDOW_MS + 1);
    }
    expect(await send(guest, "song.auth.qr.check", { key: "qr-key" })).toBe("RATE_LIMITED");
    advance(MUSIC_AUTH_RATE_LIMIT_WINDOW_MS + 1);
    expect(await send(guest, "song.auth.qr.check", { key: "qr-key" })).not.toBe("RATE_LIMITED");
  });

  test("正常扫码节奏（每 2 秒轮询一次，一张码两分钟）不会被限", async () => {
    const { guest, send, advance } = await setup();
    expect(await send(guest, "song.auth.qr.create")).toBe("ok");
    for (let poll = 0; poll < 60; poll += 1) {
      expect(await send(guest, "song.auth.qr.check", { key: "qr-key" })).not.toBe("RATE_LIMITED");
      advance(2_000);
    }
    // 过期后换一张新码继续扫。
    expect(await send(guest, "song.auth.qr.create")).toBe("ok");
    for (let poll = 0; poll < 30; poll += 1) {
      expect(await send(guest, "song.auth.qr.check", { key: "qr-key" })).not.toBe("RATE_LIMITED");
      advance(2_000);
    }
  });
});
