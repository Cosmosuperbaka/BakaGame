import { describe, expect, test } from "bun:test";

import { FAKER_DESCRIPTION_MAX_UNITS, textUnits } from "../../src/shared/TextUnits";
import type { WhoIsFakerRoomSnapshot } from "../../src/shared/Index";
import {
  createConnection,
  createTestContext,
  execute,
  getLastEventPayload,
  type TestConnection,
} from "../Helpers";

// 描述的字宽上限过去只有 Agent 入口强制，改过的客户端能发任意长的描述（协议只限 500 个字符）。
// 现在玩法命令入口用同一个函数与常量校验：超限拒绝并说明上限，刚好占满的照常接受。

interface Seat {
  connection: TestConnection;
  playerId: string;
}

const startDescription = async () => {
  const { service } = createTestContext();
  const roomId = "7420";
  const hostConnection = createConnection(service, `${roomId}-host`);
  const created = (await execute(service, hostConnection, {
    id: "create",
    type: "room.create",
    payload: {
      roomId,
      name: "描述上限",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
    },
  })) as { playerId: string };
  const host: Seat = { connection: hostConnection, playerId: created.playerId };
  const seats: Seat[] = [];
  for (let index = 0; index < 4; index += 1) {
    const connection = createConnection(service, `${roomId}-seat-${index}`);
    const joined = (await execute(service, connection, {
      id: `join-${index}`,
      type: "room.join",
      roomId,
      payload: { userName: `玩家${index}` },
    })) as { playerId: string };
    seats.push({ connection, playerId: joined.playerId });
  }
  await execute(service, host.connection, {
    id: "settings",
    type: "room.updateSettings",
    payload: { roleConfig: { undercoverCount: 1, hasAngel: false, hasBlank: false } },
  });
  for (const seat of [host, ...seats]) {
    await execute(service, seat.connection, {
      id: `ready-${seat.playerId}`,
      type: "player.setReady",
      payload: { ready: true },
    });
  }
  await execute(service, host.connection, { id: "start", type: "game.advancePhase", payload: {} });
  await execute(service, host.connection, {
    id: "assign",
    type: "game.assignQuestioner",
    payload: { playerId: seats[3].playerId },
  });
  await execute(service, seats[3].connection, {
    id: "words",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });
  const snapshot = () =>
    getLastEventPayload<WhoIsFakerRoomSnapshot>(host.connection, "room.snapshot")!;
  expect(snapshot().status.phase).toBe("description");
  /** 当前轮到的人：描述按服务端排定的顺序提交。 */
  const speaker = () => {
    const order = snapshot().status.descriptionOrder!;
    const next = order.find(
      (playerId) => !snapshot().descriptions.some((record) => record.playerId === playerId)
    )!;
    return [host, ...seats].find((seat) => seat.playerId === next)!;
  };
  const submit = (seat: Seat, text: string) =>
    execute(service, seat.connection, {
      id: `desc-${Math.random()}`,
      type: "game.submitDescription",
      payload: { text },
    });
  return { service, snapshot, speaker, submit };
};

const TEN_HAN = "天地玄黄宇宙洪荒日月";

describe("卧底描述的字宽上限在命令入口强制", () => {
  test("前提：上限是 20 个字宽单位，十个汉字刚好占满", () => {
    expect(FAKER_DESCRIPTION_MAX_UNITS).toBe(20);
    expect(textUnits(TEN_HAN)).toBe(20);
  });

  test("刚好占满的描述照常接受（十个汉字、二十个英文字符）", async () => {
    const f = await startDescription();
    await expect(f.submit(f.speaker(), TEN_HAN)).resolves.toBeDefined();
    await expect(f.submit(f.speaker(), "abcdefghijklmnopqrst")).resolves.toBeDefined();
    expect(f.snapshot().descriptions.map((record) => record.text)).toEqual([
      TEN_HAN,
      "abcdefghijklmnopqrst",
    ]);
  });

  test("超限的描述被拒绝并说明上限，不留下任何记录，本人可以改短重发", async () => {
    const f = await startDescription();
    const seat = f.speaker();
    for (const text of [`${TEN_HAN}盈`, `${TEN_HAN}a`, "a".repeat(21), "盈".repeat(500)]) {
      await expect(f.submit(seat, text)).rejects.toMatchObject({
        code: "INVALID_DESCRIPTION",
        message: expect.stringContaining("20"),
      });
    }
    expect(f.snapshot().descriptions).toEqual([]);
    await expect(f.submit(seat, TEN_HAN)).resolves.toBeDefined();
    expect(f.snapshot().descriptions).toHaveLength(1);
  });

  test("按归一后的文本计宽：首尾空白与连续空白折叠后刚好占满的照常接受", async () => {
    const f = await startDescription();
    await expect(f.submit(f.speaker(), `   ${TEN_HAN}   `)).resolves.toBeDefined();
    await expect(f.submit(f.speaker(), "ab    cd")).resolves.toBeDefined();
  });
});
