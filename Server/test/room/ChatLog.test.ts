import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  ChatLimiter,
  SYSTEM_SENDER,
  acceptChatText,
  appendChat,
  systemMessage,
} from "../../src/application/room/ChatLog";
import {
  CHAT_LIMIT,
  CHAT_RATE_LIMIT_PER_CONNECTION,
  CHAT_RATE_LIMIT_WINDOW_MS,
} from "../../src/config/Constants";
import {
  SensitiveTextFilter,
  setSensitiveTextFilterForTest,
} from "../../src/infrastructure/SensitiveText";
import type { ChatMessage } from "../../src/shared/Model";
import { expectAppError } from "./RoomKernelFixtures";

beforeAll(() => setSensitiveTextFilterForTest(new SensitiveTextFilter(["占位违禁词"])));
afterAll(() => setSensitiveTextFilterForTest(undefined));

const EMPTY = { code: "INVALID_MESSAGE", message: "消息不能为空" };

const message = (id: string): ChatMessage => ({
  id,
  playerId: "p",
  playerName: "P",
  text: id,
  createdAt: 0,
  system: false,
});

describe("聊天限流", () => {
  test("缺省额度取公共常量：超额被拒，别的连接不受影响，窗口过后恢复", () => {
    const clock = { now: 0 };
    const limiter = new ChatLimiter({ now: () => clock.now });
    for (let index = 0; index < CHAT_RATE_LIMIT_PER_CONNECTION; index += 1) limiter.consume("c1");
    expectAppError(() => limiter.consume("c1"), "RATE_LIMITED");
    expect(() => limiter.consume("c2")).not.toThrow();
    clock.now += CHAT_RATE_LIMIT_WINDOW_MS + 1;
    expect(() => limiter.consume("c1")).not.toThrow();
  });

  test("玩法现值可以覆盖额度与文案", () => {
    const limiter = new ChatLimiter({
      now: () => 0,
      maxRequests: 1,
      windowMs: 10_000,
      rejection: { code: "RATE_LIMITED", message: "消息发送过快，请稍后再试" },
    });
    limiter.consume("c1");
    expectAppError(() => limiter.consume("c1"), "RATE_LIMITED");
  });
});

describe("聊天文本受理", () => {
  test("规范化：去控制字符、折叠空白、去首尾空白", () => {
    expect(acceptChatText("  你好​  世界\n ", { maxLength: undefined, emptyError: EMPTY })).toBe(
      "你好 世界"
    );
  });

  test("先截断再判空；不给上限时不截断", () => {
    expect(acceptChatText("abcdef", { maxLength: 3, emptyError: EMPTY })).toBe("abc");
    expect(
      acceptChatText("x".repeat(600), { maxLength: undefined, emptyError: EMPTY })
    ).toHaveLength(600);
  });

  test("只剩空白或不可见字符按空消息拒绝，错误码按玩法现值", () => {
    expectAppError(
      () => acceptChatText(" ​\t ", { maxLength: 200, emptyError: EMPTY }),
      "INVALID_MESSAGE"
    );
    expectAppError(
      () =>
        acceptChatText("", {
          maxLength: 500,
          emptyError: { code: "EMPTY_MESSAGE", message: "消息不能为空" },
        }),
      "EMPTY_MESSAGE"
    );
  });

  test("敏感词按规范化后的文本判定，插空格的规避写法同样被拒", () => {
    expectAppError(
      () => acceptChatText("占位违禁词", { maxLength: undefined, emptyError: EMPTY }),
      "TEXT_SENSITIVE"
    );
    expectAppError(
      () => acceptChatText("占 位 违 禁 词", { maxLength: undefined, emptyError: EMPTY }),
      "TEXT_SENSITIVE"
    );
  });
});

describe("聊天追加", () => {
  test("挤出最旧、追加最新，保持滑动窗口形状；不改动旧数组", () => {
    const room = { chat: Array.from({ length: CHAT_LIMIT }, (_, index) => message(`m${index}`)) };
    const previous = room.chat;
    appendChat(room, message("new"));
    expect(room.chat).toHaveLength(CHAT_LIMIT);
    expect(room.chat[0].id).toBe("m1");
    expect(room.chat.at(-1)?.id).toBe("new");
    expect(previous).toHaveLength(CHAT_LIMIT);
    expect(previous.at(-1)?.id).toBe(`m${CHAT_LIMIT - 1}`);
    expect(room.chat).not.toBe(previous);
  });

  test("未满时只追加；自定义上限生效", () => {
    const room = { chat: [message("a")] };
    appendChat(room, message("b"));
    expect(room.chat.map((item) => item.id)).toEqual(["a", "b"]);
    appendChat(room, message("c"), 2);
    expect(room.chat.map((item) => item.id)).toEqual(["b", "c"]);
  });
});

describe("系统消息", () => {
  test("缺省发送者占位为系统；可按玩法现值传入；频道只在给出时出现", () => {
    expect(systemMessage({ id: "s1", text: "开局", createdAt: 5 })).toEqual({
      id: "s1",
      playerId: SYSTEM_SENDER.playerId,
      playerName: SYSTEM_SENDER.playerName,
      text: "开局",
      createdAt: 5,
      system: true,
    });
    expect(
      systemMessage({
        id: "s2",
        text: "开局",
        createdAt: 5,
        sender: { playerId: "", playerName: "" },
        channel: "main",
      })
    ).toMatchObject({ playerId: "", playerName: "", channel: "main", system: true });
  });
});
