import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { CEEOriginalService } from "../src/application/CEEOriginalService";
import { CEEService } from "../src/application/CEEService";
import {
  SensitiveTextFilter,
  setSensitiveTextFilterForTest,
} from "../src/infrastructure/SensitiveText";
import type { CEERoomEnterResult, ConnectionRecord } from "../src/shared/Index";
import { FixtureRoom, originalData } from "./CEEOriginalFixtures";

// 只用占位词：测试文件里不出现真实敏感词。
const BAD = "测试违禁词A";
const filter = new SensitiveTextFilter([BAD]);
beforeAll(() => setSensitiveTextFilterForTest(filter));
afterAll(() => setSensitiveTextFilterForTest(undefined));

const services: CEEService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});

function setup() {
  const upstream = new FixtureRoom();
  const original = new CEEOriginalService({
    data: originalData,
    serverUrl: "https://chat-sensitive.invalid",
    aesSecret: "chat-sensitive-key",
    socketFactory: upstream.factory,
    fetcher: async () => Response.json([]),
  });
  const service = new CEEService({ data: originalData, originalService: original });
  services.push(service);
  const connect = (id: string) => {
    const record: ConnectionRecord = { id, lobbySubscribed: false, send() {}, close() {} };
    service.registerConnection(record);
    return record.id;
  };
  const run = (id: string, message: Record<string, unknown>) =>
    service.execute(id, { id: crypto.randomUUID(), ...message } as never);
  const enter = async (id: string, source: "native" | "original", roomId: string) => {
    const entered = (await run(connect(id), {
      type: "cee.room.create",
      payload: {
        source,
        roomId,
        name: "房间",
        userName: "房主",
        visibility: "public",
        allowSpectators: true,
      },
    })) as CEERoomEnterResult;
    return { id, roomId, sessionToken: entered.sessionToken };
  };
  const chat = (who: { id: string; roomId: string; sessionToken: string }, text: string) =>
    run(who.id, {
      type: "cee.chat.send",
      roomId: who.roomId,
      sessionToken: who.sessionToken,
      payload: { text },
    });
  return { enter, chat };
}

/** 一条聊天只能被敏感词过滤器看一次：入口与内核各查一遍既浪费，也让两处口径各自漂移。 */
describe("聊天敏感词检测只做一次", () => {
  for (const source of ["native", "original"] as const) {
    test(`${source === "native" ? "增强房" : "原版房"}：含敏感词的聊天被拒且只检测一次，正常聊天同样只检测一次`, async () => {
      const { enter, chat } = setup();
      const who = await enter("host", source, source === "native" ? "1234" : "4321");
      const matches = spyOn(filter, "matches");
      try {
        await expect(chat(who, BAD)).rejects.toMatchObject({ code: "TEXT_SENSITIVE" });
        expect(matches).toHaveBeenCalledTimes(1);
        matches.mockClear();
        await chat(who, "大家好");
        expect(matches).toHaveBeenCalledTimes(1);
      } finally {
        matches.mockRestore();
      }
    });
  }

  test("增强房：插空格的规避写法同样被拒", async () => {
    const { enter, chat } = setup();
    const who = await enter("host", "native", "1234");
    await expect(chat(who, "测 试 违 禁 词 A")).rejects.toMatchObject({ code: "TEXT_SENSITIVE" });
  });
});
