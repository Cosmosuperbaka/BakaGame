import { expect, test } from "bun:test";

import { parseSonGuessrMessage } from "../src/transport/SonGuessrProtocol";

test("SonGuessr 协议解析房间设置与游戏命令", () => {
  expect(parseSonGuessrMessage({
    id: "sync",
    type: "song.room.requestSync",
    roomId: "1234",
    payload: {},
  })).toMatchObject({ type: "song.room.requestSync", payload: {} });

  expect(
    parseSonGuessrMessage({
      id: "1",
      type: "song.room.updateSettings",
      roomId: "1234",
      sessionToken: "token",
      payload: {
        lyricsLineCount: 7,
        showLyrics: false,
        autoRotateSubmitter: true,
        bloodMode: true,
        showGuessTimer: false,
        allowSpectators: false,
      },
    }),
  ).toMatchObject({
    type: "song.room.updateSettings",
    roomId: "1234",
    payload: {
      lyricsLineCount: 7,
      showLyrics: false,
      autoRotateSubmitter: true,
      bloodMode: true,
      showGuessTimer: false,
      allowSpectators: false,
    },
  });
});

test("SonGuessr 协议解析题目设置与自动筛选", () => {
  expect(parseSonGuessrMessage({
    id: "question-settings",
    type: "song.room.updateSettings",
    payload: {
      questionType: "song",
      questionMode: "automatic",
      autoFilters: {
        playlist: { id: "123", name: "测试歌单", songCount: 10 },
        artists: [{ id: "7", name: "测试歌手" }],
        minPopularity: 10_000,
      },
    },
  })).toMatchObject({
    payload: {
      questionType: "song",
      questionMode: "automatic",
      autoFilters: {
        playlist: { id: "123" },
        artists: [{ id: "7", name: "测试歌手" }],
        minPopularity: 10_000,
      },
    },
  });
});

test("SonGuessr 协议拒绝非法音频准备回合号", () => {
  for (const roundNumber of ["1", 0, -1, 1.5]) {
    expect(() =>
      parseSonGuessrMessage({
        id: "1",
        type: "song.game.audioReady",
        payload: { roundNumber },
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
  }
});

test("SonGuessr 协议解析旁观、放弃与测试人机命令", () => {
  expect(parseSonGuessrMessage({
    id: "spectator",
    type: "song.player.setSpectator",
    payload: { spectator: true },
  })).toMatchObject({ type: "song.player.setSpectator", payload: { spectator: true } });

  expect(parseSonGuessrMessage({
    id: "give-up",
    type: "song.game.giveUp",
    payload: {},
  })).toMatchObject({ type: "song.game.giveUp", payload: {} });

  expect(parseSonGuessrMessage({
    id: "bots",
    type: "song.test.addBot",
    payload: { count: 3 },
  })).toMatchObject({ type: "song.test.addBot", payload: { count: 3 } });

  for (const count of [0, -1, 1.5, "2"]) {
    expect(() => parseSonGuessrMessage({
      id: "invalid-bots",
      type: "song.test.removeBot",
      payload: { count },
    })).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
  }
});

test("SonGuessr 协议只解析扫码与 Cookie 登录命令", () => {
  expect(parseSonGuessrMessage({
    id: "qr",
    type: "song.auth.qr.check",
    payload: { key: "qr-key" },
  })).toMatchObject({ type: "song.auth.qr.check", payload: { key: "qr-key" } });

  for (const type of ["song.auth.phone.login", "song.auth.email.login"]) {
    expect(() => parseSonGuessrMessage({ id: "removed-login", type, payload: {} })).toThrow(
      expect.objectContaining({ code: "UNKNOWN_MESSAGE_TYPE" }),
    );
  }

  expect(parseSonGuessrMessage({
    id: "cookie",
    type: "song.auth.useCookie",
    payload: { cookie: "MUSIC_U=test" },
  })).toMatchObject({ type: "song.auth.useCookie", payload: { cookie: "MUSIC_U=test" } });
});

test("SonGuessr 协议严格拦截 payload null 与未知属性", () => {
  // 1. 拒绝 payload: null
  expect(() =>
    parseSonGuessrMessage({
      id: "null-payload",
      type: "song.room.leave",
      payload: null,
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));

  // 2. 拒绝未声明的信封脏字段
  expect(() =>
    parseSonGuessrMessage({
      id: "extra-envelope",
      type: "song.room.leave",
      payload: {},
      extraField: "hacker",
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));

  // 3. 拒绝未声明的 payload 脏字段
  expect(() =>
    parseSonGuessrMessage({
      id: "extra-payload",
      type: "song.room.leave",
      payload: { dirty: 123 },
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
});

test("SonGuessr 协议支持 16,384 字符合法 Cookie 并拦截超长凭据", () => {
  // 501~16384 字符的 Cookie 应被正常解析放行
  const validLongCookie = "MUSIC_U=" + "a".repeat(1000);
  const parsed = parseSonGuessrMessage({
    id: "long-cookie",
    type: "song.auth.useCookie",
    payload: { cookie: validLongCookie },
  });
  expect((parsed.payload as { cookie: string }).cookie).toBe(validLongCookie);

  const maxValidCookie = "a".repeat(16_384);
  const parsedMax = parseSonGuessrMessage({
    id: "max-cookie",
    type: "song.auth.useCookie",
    payload: { cookie: maxValidCookie },
  });
  expect((parsedMax.payload as { cookie: string }).cookie).toBe(maxValidCookie);

  // 超过 16384 字符必须被拦截
  const tooLongCookie = "a".repeat(16_385);
  expect(() =>
    parseSonGuessrMessage({
      id: "too-long-cookie",
      type: "song.auth.useCookie",
      payload: { cookie: tooLongCookie },
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
});

