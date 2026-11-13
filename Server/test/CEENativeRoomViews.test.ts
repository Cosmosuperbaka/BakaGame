import { afterEach, describe, expect, test } from "bun:test";
import { ceeTestHarness } from "./CEENativeFixtures";
import { CEEService } from "../src/application/CEEService";
import { AppError } from "../src/domain/Errors";
import { CHAT_LIMIT } from "../src/config/Constants";
import { ROOM_ID_TEST_MODE, type ConnectionRecord } from "../src/shared/Index";

const active: ReturnType<typeof ceeTestHarness>[] = [];
const harness = (roomId?: string) => {
  const result = ceeTestHarness({}, undefined, roomId ? { roomId } : {});
  active.push(result);
  return result;
};
afterEach(() => {
  active.splice(0).forEach((test) => test.service.close());
});

describe("CEE 房间聊天", () => {
  test("消息截断到 500 个字符，系统消息的发送者占位是两个空串", async () => {
    const h = harness();
    const host = await h.create();
    expect(h.snapshot(host).chat[0]).toMatchObject({
      playerId: "",
      playerName: "",
      text: "房主 创建了房间",
      system: true,
    });
    await h.send(host, "cee.chat.send", { text: "好".repeat(600) });
    expect(h.snapshot(host).chat.at(-1)?.text).toBe("好".repeat(500));
  });

  test("只保留最近的消息，系统消息与玩家消息共用同一个窗口", async () => {
    const h = harness();
    const host = await h.create();
    for (let index = 0; index < CHAT_LIMIT + 5; index += 1)
      await h.send(host, "cee.chat.send", { text: `msg${index}` });
    const chat = h.snapshot(host).chat;
    expect(chat).toHaveLength(CHAT_LIMIT);
    expect(chat.at(-1)?.text).toBe(`msg${CHAT_LIMIT + 4}`);
    expect(chat[0].text).toBe("msg5");
  });

  test("入口按连接限制聊天额度：窗口内第 9 条被拒，窗口过去后恢复", async () => {
    let clock = 1_000_000;
    const unused = async (): Promise<never> => {
      throw new AppError("UNUSED", "测试不读取数据");
    };
    const service = new CEEService({
      now: () => clock,
      data: {
        searchCharacters: unused,
        searchSubjects: unused,
        getSubjectCharacters: unused,
        getSubjects: unused,
        getRawCharacter: unused,
        getCharacter: unused,
        chooseRandomCharacter: unused,
        importDirectory: unused,
        resolveCharacterImage: unused,
        resolveSubjectImage: unused,
        close() {},
      },
    });
    const record: ConnectionRecord = {
      id: "chatter",
      lobbySubscribed: false,
      send: () => {},
      close: () => {},
    };
    service.registerConnection(record);
    const run = (message: Record<string, unknown>) =>
      service.execute(record.id, { id: crypto.randomUUID(), ...message } as never);
    const entered = (await run({
      type: "cee.room.create",
      payload: {
        source: "native",
        roomId: "1234",
        name: "房间",
        userName: "房主",
        visibility: "public",
        allowSpectators: true,
      },
    })) as { sessionToken: string };
    const chat = (text: string) =>
      run({
        type: "cee.chat.send",
        roomId: "1234",
        sessionToken: entered.sessionToken,
        payload: { text },
      });
    for (let index = 0; index < 8; index += 1) await chat(`msg${index}`);
    await expect(chat("第 9 条")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "消息发送过快，请稍后再试",
    });
    clock += 10_001;
    await chat("窗口过去后");
    service.native.close();
  });
});

describe("CEE 后台房间视图与健康快照", () => {
  test("后台视图列出成员与房间事实，测试房标记为隐藏", async () => {
    const h = harness();
    const host = await h.create();
    const guest = await h.join("玩家");
    await h.send(host, "cee.room.update", {
      name: "私密房",
      visibility: "private",
      password: "abcd",
      allowSpectators: false,
    });
    h.service.unregisterConnection(guest.record.id);
    const [view] = h.service.adminListRooms();
    expect(view).toEqual({
      game: "cee",
      roomId: "1234",
      name: "私密房",
      phase: "waiting",
      visibility: "private",
      hasPassword: true,
      hidden: false,
      roundNumber: 0,
      createdAt: view.createdAt,
      lastActiveAt: view.lastActiveAt,
      players: [
        {
          id: host.id!,
          name: "房主",
          online: true,
          membership: "active",
          host: true,
          bot: false,
          userId: null,
        },
        {
          id: guest.id!,
          name: "玩家",
          online: false,
          membership: "active",
          host: false,
          bot: false,
          userId: null,
        },
      ],
    });

    const solo = harness(ROOM_ID_TEST_MODE);
    await solo.create();
    expect(solo.service.adminListRooms()[0]).toMatchObject({
      roomId: ROOM_ID_TEST_MODE,
      hidden: true,
    });
  });

  test("健康快照的在线人数只计在线成员", async () => {
    const h = harness();
    await h.create();
    const guest = await h.join("玩家");
    await h.join("第三人");
    h.service.unregisterConnection(guest.record.id);
    expect(h.service.getHealthSnapshot()).toMatchObject({
      roomCount: 1,
      playerCount: 3,
      onlinePlayerCount: 2,
    });
  });
});
