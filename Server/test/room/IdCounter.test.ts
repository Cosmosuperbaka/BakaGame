import { describe, expect, test } from "bun:test";

import { IdCounter } from "../../src/application/room/IdCounter";

// 两款玩法今天各自的回收形状，接入时原样传入。
const FAKER_IDS = /^(?:round|description|chat|player|session)_([0-9a-z]+)$/;
const SONG_IDS = /^song_(?:chat|guess|player)_([0-9a-z]+)$/;

describe("进程内发号", () => {
  test("按前缀递增发号，序号用 base36", () => {
    const ids = new IdCounter(FAKER_IDS);
    expect(ids.next("player")).toBe("player_1");
    expect(ids.next("chat")).toBe("chat_2");
    for (let index = 0; index < 33; index += 1) ids.next("x");
    expect(ids.next("round")).toBe("round_10");
  });

  test("回收快照里最大的序号：嵌套对象与数组都会遍历，新号不再撞旧号", () => {
    const ids = new IdCounter(FAKER_IDS);
    ids.absorb({
      players: { player_3: { id: "player_3" }, player_z: { id: "player_z" } },
      chat: [{ id: "chat_a" }],
      round: { id: "round_2", history: [["description_10"]] },
    });
    expect(ids.next("player")).toBe("player_11");
  });

  test("只认本玩法的形状：别的前缀、派生座位号与带尾巴的令牌都不回收", () => {
    const ids = new IdCounter(SONG_IDS);
    ids.absorb({
      a: "player_zz",
      b: "tab_ffffffffffffffffffffffffffffffff",
      c: "song_session_9_abcdef",
      d: "song_player_5",
    });
    expect(ids.next("song_player")).toBe("song_player_6");
  });

  test("回收不会把计数器往回拨；循环引用不会死循环", () => {
    const ids = new IdCounter(FAKER_IDS);
    for (let index = 0; index < 20; index += 1) ids.next("player");
    const cyclic: Record<string, unknown> = { id: "player_3" };
    cyclic.self = cyclic;
    ids.absorb(cyclic);
    expect(ids.next("player")).toBe("player_l");
  });
});
