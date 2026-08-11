import { expect, test } from "bun:test";

import { parseSongGuessrMessage } from "../src/transport/songguessr-protocol";

test("Songuessr 协议解析房间设置与游戏命令", () => {
  expect(
    parseSongGuessrMessage({
      id: "1",
      type: "song.room.updateSettings",
      roomId: "1234",
      sessionToken: "token",
      payload: {
        lyricsLineCount: 7,
        showLyrics: false,
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
      bloodMode: true,
      showGuessTimer: false,
      allowSpectators: false,
    },
  });
});

test("Songuessr 协议解析题目设置与自动筛选", () => {
  expect(parseSongGuessrMessage({
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

test("Songuessr 协议拒绝非法音频准备回合号", () => {
  for (const roundNumber of ["1", 0, -1, 1.5]) {
    expect(() =>
      parseSongGuessrMessage({
        id: "1",
        type: "song.game.audioReady",
        payload: { roundNumber },
      }),
    ).toThrow();
  }
});

test("Songuessr 协议解析旁观、放弃与测试人机命令", () => {
  expect(parseSongGuessrMessage({
    id: "spectator",
    type: "song.player.setSpectator",
    payload: { spectator: true },
  })).toMatchObject({ type: "song.player.setSpectator", payload: { spectator: true } });

  expect(parseSongGuessrMessage({
    id: "give-up",
    type: "song.game.giveUp",
    payload: {},
  })).toMatchObject({ type: "song.game.giveUp", payload: {} });

  expect(parseSongGuessrMessage({
    id: "bots",
    type: "song.test.addBot",
    payload: { count: 3 },
  })).toMatchObject({ type: "song.test.addBot", payload: { count: 3 } });

  for (const count of [0, -1, 1.5, "2"]) {
    expect(() => parseSongGuessrMessage({
      id: "invalid-bots",
      type: "song.test.removeBot",
      payload: { count },
    })).toThrow();
  }
});

test("Songuessr 协议只解析扫码与 Cookie 登录命令", () => {
  expect(parseSongGuessrMessage({
    id: "qr",
    type: "song.auth.qr.check",
    payload: { key: "qr-key" },
  })).toMatchObject({ type: "song.auth.qr.check", payload: { key: "qr-key" } });

  for (const type of ["song.auth.phone.login", "song.auth.email.login"]) {
    expect(() => parseSongGuessrMessage({ id: "removed-login", type, payload: {} })).toThrow();
  }

  expect(parseSongGuessrMessage({
    id: "cookie",
    type: "song.auth.useCookie",
    payload: { cookie: "MUSIC_U=test" },
  })).toMatchObject({ type: "song.auth.useCookie", payload: { cookie: "MUSIC_U=test" } });
});
