import { expect, test } from "bun:test";

import { parseSongGuessrMessage } from "../src/transport/songguessr-protocol";

test("Song Guessr 协议解析房间设置与游戏命令", () => {
  expect(
    parseSongGuessrMessage({
      id: "1",
      type: "song.room.updateSettings",
      roomId: "1234",
      sessionToken: "token",
      payload: {
        lyricsLineCount: 7,
        endOnFirstCorrect: true,
        allowSpectators: false,
      },
    }),
  ).toMatchObject({
    type: "song.room.updateSettings",
    roomId: "1234",
    payload: {
      lyricsLineCount: 7,
      endOnFirstCorrect: true,
      allowSpectators: false,
    },
  });
});

test("Song Guessr 协议拒绝非法音频准备回合号", () => {
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

test("Song Guessr 协议解析旁观、放弃与测试人机命令", () => {
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

test("Song Guessr 协议解析扫码、手机、邮箱与 Cookie 登录命令", () => {
  expect(parseSongGuessrMessage({
    id: "qr",
    type: "song.auth.qr.check",
    payload: { key: "qr-key" },
  })).toMatchObject({ type: "song.auth.qr.check", payload: { key: "qr-key" } });

  expect(parseSongGuessrMessage({
    id: "phone",
    type: "song.auth.phone.login",
    payload: { phone: "13800000000", countryCode: "86", captcha: "123456" },
  })).toMatchObject({
    type: "song.auth.phone.login",
    payload: { phone: "13800000000", countryCode: "86", captcha: "123456" },
  });

  expect(parseSongGuessrMessage({
    id: "email",
    type: "song.auth.email.login",
    payload: { email: "user@example.com", password: "secret" },
  })).toMatchObject({
    type: "song.auth.email.login",
    payload: { email: "user@example.com", password: "secret" },
  });

  expect(parseSongGuessrMessage({
    id: "cookie",
    type: "song.auth.useCookie",
    payload: { cookie: "MUSIC_U=test" },
  })).toMatchObject({ type: "song.auth.useCookie", payload: { cookie: "MUSIC_U=test" } });
});
