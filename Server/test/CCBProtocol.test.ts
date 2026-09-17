import { expect, test } from "bun:test";

import { parseCCBMessage } from "../src/transport/CCBProtocol";

test("CCB 协议解析大厅与房间生命周期指令", () => {
  expect(
    parseCCBMessage({ id: "lobby", type: "ccb.lobby.subscribeRooms", payload: {} }),
  ).toMatchObject({ type: "ccb.lobby.subscribeRooms", payload: {} });

  expect(
    parseCCBMessage({
      id: "create",
      type: "ccb.room.create",
      payload: {
        roomId: "1234",
        name: "猜角色房",
        visibility: "private",
        password: "pw",
        allowSpectators: true,
        userName: "房主",
        settings: { mode: "sync", maxAttempts: 8, metaTags: ["动画", "科幻"] },
      },
    }),
  ).toMatchObject({
    type: "ccb.room.create",
    payload: {
      roomId: "1234",
      visibility: "private",
      settings: { mode: "sync", maxAttempts: 8, metaTags: ["动画", "科幻"] },
    },
  });

  expect(
    parseCCBMessage({
      id: "join",
      type: "ccb.room.join",
      roomId: "1234",
      payload: { userName: "玩家", password: "pw" },
    }),
  ).toMatchObject({ type: "ccb.room.join", roomId: "1234", payload: { userName: "玩家" } });

  expect(
    parseCCBMessage({
      id: "reconnect",
      type: "ccb.room.reconnect",
      sessionToken: "token",
      payload: { roomId: "1234", sessionToken: "ccb_session_1_abc" },
    }),
  ).toMatchObject({ type: "ccb.room.reconnect", payload: { roomId: "1234" } });

  expect(parseCCBMessage({ id: "leave", type: "ccb.room.leave", payload: {} })).toMatchObject({
    type: "ccb.room.leave",
  });
  expect(
    parseCCBMessage({ id: "sync", type: "ccb.room.requestSync", payload: {} }),
  ).toMatchObject({ type: "ccb.room.requestSync", payload: {} });
});

test("CCB 协议解析成员与聊天指令", () => {
  expect(
    parseCCBMessage({
      id: "ready",
      type: "ccb.player.setReady",
      payload: { ready: true },
    }),
  ).toMatchObject({ payload: { ready: true } });

  expect(
    parseCCBMessage({
      id: "spectator",
      type: "ccb.player.setSpectator",
      payload: { spectator: true },
    }),
  ).toMatchObject({ payload: { spectator: true } });

  expect(
    parseCCBMessage({
      id: "message",
      type: "ccb.player.setMessage",
      payload: { message: "本命是红莉栖" },
    }),
  ).toMatchObject({ payload: { message: "本命是红莉栖" } });

  expect(
    parseCCBMessage({ id: "chat", type: "ccb.chat.send", payload: { text: "来了" } }),
  ).toMatchObject({ payload: { text: "来了" } });

  expect(
    parseCCBMessage({
      id: "kick",
      type: "ccb.room.kick",
      payload: { playerId: "ccb_player_1" },
    }),
  ).toMatchObject({ payload: { playerId: "ccb_player_1" } });

  expect(
    parseCCBMessage({
      id: "transfer",
      type: "ccb.room.transferHost",
      payload: { playerId: "ccb_player_2" },
    }),
  ).toMatchObject({ payload: { playerId: "ccb_player_2" } });

  expect(
    parseCCBMessage({ id: "add", type: "ccb.test.addBot", payload: { count: 3 } }),
  ).toMatchObject({ payload: { count: 3 } });
  expect(
    parseCCBMessage({ id: "remove", type: "ccb.test.removeBot", payload: {} }),
  ).toMatchObject({ type: "ccb.test.removeBot", payload: {} });
});

test("CCB 协议解析房间设置并拒绝越界取值", () => {
  expect(
    parseCCBMessage({
      id: "settings",
      type: "ccb.room.updateSettings",
      roomId: "1234",
      payload: {
        name: "新名字",
        visibility: "public",
        allowSpectators: false,
        mode: "bloodbath",
        topNSubjects: 300,
        startYear: 2015,
        endYear: 2026,
        metaTags: ["动画"],
        maxAttempts: 20,
        timeLimitMs: 120_000,
        useHints: [5, 3],
        useImageHint: 7,
        tagBan: true,
        globalPick: true,
      },
    }),
  ).toMatchObject({
    payload: {
      mode: "bloodbath",
      topNSubjects: 300,
      metaTags: ["动画"],
      maxAttempts: 20,
      timeLimitMs: 120_000,
      useHints: [5, 3],
      useImageHint: 7,
      tagBan: true,
      globalPick: true,
    },
  });

  // 模式是枚举；metaTags 不能为空数组，提示阈值不能为负
  expect(() =>
    parseCCBMessage({
      id: "bad-mode",
      type: "ccb.room.updateSettings",
      payload: { mode: "team" },
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));

  expect(() =>
    parseCCBMessage({
      id: "bad-meta-tags",
      type: "ccb.room.updateSettings",
      payload: { metaTags: [] },
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));

  expect(() =>
    parseCCBMessage({
      id: "bad-hint-threshold",
      type: "ccb.room.updateSettings",
      payload: { useImageHint: -1 },
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));

  // 次数上限、年份与时限都必须在 Schema 区间内，超出即拒绝而不是静默夹取
  expect(() =>
    parseCCBMessage({
      id: "bad-guess-limit",
      type: "ccb.room.updateSettings",
      payload: { maxAttempts: 0 },
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));

  expect(() =>
    parseCCBMessage({
      id: "bad-year",
      type: "ccb.room.updateSettings",
      payload: { startYear: 1800 },
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));

  expect(() =>
    parseCCBMessage({
      id: "bad-time-limit",
      type: "ccb.room.updateSettings",
      payload: { timeLimitMs: 3_600_001 },
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
});

test("CCB 协议拒绝脏字段、非法载荷与未挂载指令", () => {
  // additionalProperties: false 是脏字段防线，不能在信封与载荷两侧失守
  expect(() =>
    parseCCBMessage({ id: "dirty", type: "ccb.room.leave", payload: { extra: 1 } }),
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));

  expect(() =>
    parseCCBMessage({ id: "dirty-envelope", type: "ccb.room.leave", payload: {}, foo: 1 }),
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));

  expect(() =>
    parseCCBMessage({ id: "null-payload", type: "ccb.room.leave", payload: null }),
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));

  expect(() => parseCCBMessage({ id: "no-type", payload: {} })).toThrow(
    expect.objectContaining({ code: "INVALID_MESSAGE" }),
  );

  expect(() => parseCCBMessage("{")).toThrow(
    expect.objectContaining({ code: "INVALID_MESSAGE" }),
  );

  // 对局指令已在 P1b 挂载；P3 的手动出题指令仍未挂载，此刻应明确报未知类型。
  expect(parseCCBMessage({ id: "start", type: "ccb.game.start", payload: {} })).toMatchObject({
    type: "ccb.game.start",
  });
  expect(() =>
    parseCCBMessage({ id: "set-answer", type: "ccb.game.setAnswer", payload: {} }),
  ).toThrow(expect.objectContaining({ code: "UNKNOWN_MESSAGE_TYPE" }));
});

test("CCB 协议接受 JSON 字符串输入", () => {
  expect(
    parseCCBMessage(
      JSON.stringify({ id: "chat", type: "ccb.chat.send", payload: { text: "字符串载荷" } }),
    ),
  ).toMatchObject({ type: "ccb.chat.send", payload: { text: "字符串载荷" } });
});
