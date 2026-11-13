import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CEEOriginalService } from "../src/application/CEEOriginalService";
import { CEEService } from "../src/application/CEEService";
import type { CEERoomEnterResult, ConnectionRecord } from "../src/shared/Index";
import { FixtureRoom, originalData } from "./CEEOriginalFixtures";

const services: CEEService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});

/**
 * 原版房的聊天额度只由入口层的聊天限流把关（同一个连接号、同一个十秒八条的窗口）。
 * 原版服务自己不再另设一道：它在生产里只会经入口层收到消息，超限的请求到不了它。
 * 这里用原版服务的受理次数证明这一点：无论怎么连发或在窗口内重试，一个窗口内它最多收到八条聊天。
 */
describe("原版房聊天限流只在入口层", () => {
  const setup = () => {
    let now = 1_000;
    const upstream = new FixtureRoom();
    const original = new CEEOriginalService({
      data: originalData,
      serverUrl: "https://chat-limit.invalid",
      aesSecret: "chat-limit-key",
      socketFactory: upstream.factory,
      fetcher: async () => Response.json([{ id: "4321", isPublic: true, playerCount: 1 }]),
      now: () => now,
    });
    const service = new CEEService({
      data: originalData,
      originalService: original,
      now: () => now,
    });
    services.push(service);
    const record: ConnectionRecord = {
      id: "chatter",
      lobbySubscribed: false,
      send() {},
      close() {},
    };
    service.registerConnection(record);
    const run = (message: Record<string, unknown>) =>
      service.execute(record.id, { id: crypto.randomUUID(), ...message } as never);
    const enter = async (roomId: string) =>
      (
        (await run({
          type: "cee.room.create",
          payload: {
            source: "original",
            roomId,
            name: "房间",
            userName: "房主",
            visibility: "public",
            allowSpectators: true,
          },
        })) as CEERoomEnterResult
      ).sessionToken;
    const joinAs = async (id: string, roomId: string) => {
      service.registerConnection({ id, lobbySubscribed: false, send() {}, close() {} });
      return (
        (await service.execute(id, {
          id: crypto.randomUUID(),
          type: "cee.room.join",
          roomId,
          payload: { userName: "乙" },
        } as never)) as CEERoomEnterResult
      ).sessionToken;
    };
    const chatCalls = spyOn(original, "execute");
    const received = () =>
      chatCalls.mock.calls.filter(([, message]) => message.type === "cee.chat.send").length;
    return {
      service,
      joinAs,
      run,
      enter,
      received,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };
  const send = (h: ReturnType<typeof setup>, roomId: string, token: string, text: string) =>
    h.run({ type: "cee.chat.send", roomId, sessionToken: token, payload: { text } });

  test("连发超限与窗口内重试都被入口层拦下，原版服务一个窗口内最多收到八条", async () => {
    const h = setup();
    const room = "4321";
    const token = await h.enter(room);
    for (let index = 0; index < 8; index++) await send(h, room, token, `消息${index}`);
    for (let index = 0; index < 4; index++)
      await expect(send(h, room, token, `超限${index}`)).rejects.toMatchObject({
        code: "RATE_LIMITED",
      });
    expect(h.received()).toBe(8);

    h.advance(9_000);
    await expect(send(h, room, token, "窗口内再试")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(h.received()).toBe(8);

    h.advance(1_001);
    await send(h, room, token, "窗口滑出");
    expect(h.received()).toBe(9);
  });

  test("一条连接被限流，不牵连同房的另一条连接", async () => {
    const h = setup();
    const room = "4321";
    const token = await h.enter(room);
    for (let index = 0; index < 8; index++) await send(h, room, token, `消息${index}`);
    await expect(send(h, room, token, "超限")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const other = await h.joinAs("other", room);
    await h.service.execute("other", {
      id: crypto.randomUUID(),
      type: "cee.chat.send",
      roomId: room,
      sessionToken: other,
      payload: { text: "别人照发" },
    } as never);
    expect(h.received()).toBe(9);
  });
});
