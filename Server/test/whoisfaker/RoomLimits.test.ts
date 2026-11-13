import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";

import { TEST_MODE_MAX_PLAYERS } from "../../src/config/Constants";
import { FAKER_ROOM_MAX_MEMBERS, WhoIsFakerPayloadSchemas } from "../../src/shared/WhoIsFaker";
import { createConnection, createTestContext, execute } from "../Helpers";
import { createRoom, joinPlayers } from "./Fixtures";

// 房间人数与入参大小的上限：人数无上限时，每次状态变化的发布成本随人数平方增长；
// 补充发言名单与手动身份表的大小原本只受协议的整包大小约束。

describe("房间人数上限", () => {
  test("前提：上限与测试机器人填充时「满」的数字是同一个口径", () => {
    expect(FAKER_ROOM_MAX_MEMBERS).toBe(TEST_MODE_MAX_PLAYERS);
  });

  test("满员后入房回「房间已满」，有人离开或被移出后空出席位", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "7501");
    const joined = await joinPlayers(service, "7501", FAKER_ROOM_MAX_MEMBERS - 1, "玩家");

    const late = createConnection(service, "7501-late");
    await expect(
      execute(service, late, {
        id: "join-full",
        type: "room.join",
        roomId: "7501",
        payload: { userName: "迟到者" },
      })
    ).rejects.toMatchObject({ code: "ROOM_FULL", message: expect.stringContaining("已满") });
    const room = service.rooms.get("7501")!;
    expect(Object.keys(room.players)).toHaveLength(FAKER_ROOM_MAX_MEMBERS);

    // 被移出的席位不再占名额。
    await execute(service, host, {
      id: "kick",
      type: "room.kick",
      payload: { playerId: joined[0].joinResult.playerId },
    });
    await expect(
      execute(service, late, {
        id: "join-after-kick",
        type: "room.join",
        roomId: "7501",
        payload: { userName: "迟到者" },
      })
    ).resolves.toBeDefined();
  });

  test("满员的房间里，已有席位的标签页重新进入走回座，不被「已满」挡住", async () => {
    const { service } = createTestContext();
    await createRoom(service, "7502");
    const first = createConnection(service, "7502-first");
    first.record.tabKey = "tab-first";
    const seat = (await execute(service, first, {
      id: "join-first",
      type: "room.join",
      roomId: "7502",
      payload: { userName: "老玩家" },
    })) as { playerId: string };
    await joinPlayers(service, "7502", FAKER_ROOM_MAX_MEMBERS - 2, "玩家");
    expect(Object.keys(service.rooms.get("7502")!.players)).toHaveLength(FAKER_ROOM_MAX_MEMBERS);

    const reopened = createConnection(service, "7502-reopened");
    reopened.record.tabKey = "tab-first";
    await expect(
      execute(service, reopened, {
        id: "rejoin",
        type: "room.join",
        roomId: "7502",
        payload: { userName: "老玩家" },
      })
    ).resolves.toMatchObject({ playerId: seat.playerId });
  });

  test("旁观者同样占名额：局中满员后再来的旁观者也被拒", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "7503");
    const seated = await joinPlayers(service, "7503", 4, "玩家");
    for (const seat of seated)
      await execute(service, seat.connection, {
        id: `ready-${seat.joinResult.playerId}`,
        type: "player.setReady",
        payload: { ready: true },
      });
    await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
    const spectators = await joinPlayers(service, "7503", FAKER_ROOM_MAX_MEMBERS - 5, "旁观");
    expect(spectators).toHaveLength(FAKER_ROOM_MAX_MEMBERS - 5);
    const late = createConnection(service, "7503-late");
    await expect(
      execute(service, late, {
        id: "join-full",
        type: "room.join",
        roomId: "7503",
        payload: { userName: "再来一个" },
      })
    ).rejects.toMatchObject({ code: "ROOM_FULL" });
  });
});

describe("入参大小上限取房间人数上限", () => {
  const players = (count: number) => Array.from({ length: count }, (_, index) => `p${index}`);

  test("补充发言名单：上限个人通过，多一个被拒", () => {
    const schema = WhoIsFakerPayloadSchemas["game.requestSupplement"];
    expect(Value.Check(schema, { playerIds: players(FAKER_ROOM_MAX_MEMBERS) })).toBe(true);
    expect(Value.Check(schema, { playerIds: players(FAKER_ROOM_MAX_MEMBERS + 1) })).toBe(false);
    expect(Value.Check(schema, { playerIds: players(5000) })).toBe(false);
  });

  test("手动身份表：上限个人通过，多一个被拒", () => {
    const schema = WhoIsFakerPayloadSchemas["game.submitWords"];
    const roles = (count: number) =>
      Object.fromEntries(players(count).map((id) => [id, "civilian" as const]));
    const words: [string, string] = ["苹果", "香蕉"];
    expect(Value.Check(schema, { words, manualRoles: roles(FAKER_ROOM_MAX_MEMBERS) })).toBe(true);
    expect(Value.Check(schema, { words, manualRoles: roles(FAKER_ROOM_MAX_MEMBERS + 1) })).toBe(
      false
    );
    expect(Value.Check(schema, { words, manualRoles: roles(5000) })).toBe(false);
  });
});
