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
