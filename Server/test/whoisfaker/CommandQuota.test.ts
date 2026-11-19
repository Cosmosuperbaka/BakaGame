import { describe, expect, test } from "bun:test";

import {
  COMMAND_RATE_LIMIT_PER_CONNECTION,
  COMMAND_RATE_LIMIT_WINDOW_MS,
} from "../../src/config/Constants";
import { createTestContext, execute } from "../Helpers";
import { createRoom, joinPlayers } from "./Fixtures";

// 每条连接的命令总额度：三款共用同一个窗口与额度，超限回 RATE_LIMITED，窗口过后恢复。
// 额度在解析与守卫之前扣，所以被守卫拒绝的命令同样计数，高频乱发的人不会因为「每条都被拒」而不受限。

describe("卧底的每连接命令总额度", () => {
  test("窗口内满额度的命令照常放行，多一条回 RATE_LIMITED，窗口过后恢复", async () => {
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "7601");
    // 建房那一条已经占了一份额度。
    for (let index = 1; index < COMMAND_RATE_LIMIT_PER_CONNECTION; index += 1)
      await expect(
        execute(service, host, { id: `sync-${index}`, type: "room.requestSync", payload: {} })
      ).resolves.toBeDefined();
    await expect(
      execute(service, host, { id: "over", type: "room.requestSync", payload: {} })
    ).rejects.toMatchObject({ code: "RATE_LIMITED", message: "操作过于频繁，请稍后再试" });

    advanceTime(COMMAND_RATE_LIMIT_WINDOW_MS + 1);
    await expect(
      execute(service, host, { id: "after", type: "room.requestSync", payload: {} })
    ).resolves.toBeDefined();
  });

  test("额度按连接计：一条连接用完不影响同房的另一条", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "7602");
    const [other] = await joinPlayers(service, "7602", 1, "旁人");
    for (let index = 1; index < COMMAND_RATE_LIMIT_PER_CONNECTION; index += 1)
      await execute(service, host, { id: `s-${index}`, type: "room.requestSync", payload: {} });
    await expect(
      execute(service, host, { id: "over", type: "room.requestSync", payload: {} })
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(
      execute(service, other.connection, { id: "ok", type: "room.requestSync", payload: {} })
    ).resolves.toBeDefined();
  });

  test("额度先于守卫扣：每条都被守卫拒绝的命令同样会被限流", async () => {
    const { service } = createTestContext();
    const { host } = await createRoom(service, "7603");
    const [guest] = await joinPlayers(service, "7603", 1, "旁人");
    // 非房主发房主命令：每条都是 FORBIDDEN。
    const spam = (id: string) =>
      execute(service, guest.connection, { id, type: "game.advancePhase", payload: {} });
    for (let index = 1; index < COMMAND_RATE_LIMIT_PER_CONNECTION; index += 1)
      await expect(spam(`g-${index}`)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(spam("over")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(host).toBeDefined();
  });

  test("正常游玩的命令频率远低于额度：一整局流程里没有一条被限", async () => {
    // 额度是 10 秒 80 条（每秒 8 条）：一名玩家一局里的命令是准备、描述、投票、聊天这一量级，
    // 白板猜词草稿由客户端 220 毫秒节流（每秒不到 5 条）。这里用脚本化的一局佐证，不是证明上界。
    const { service, advanceTime } = createTestContext();
    const { host } = await createRoom(service, "7604");
    const players = await joinPlayers(service, "7604", 4, "玩家");
    for (const player of players) {
      await execute(service, player.connection, {
        id: `r-${player.joinResult.playerId}`,
        type: "player.setReady",
        payload: { ready: true },
      });
      advanceTime(300);
    }
    await execute(service, host, { id: "start", type: "game.advancePhase", payload: {} });
    // 一条连接以每 220 毫秒一条的节奏持续发草稿类命令十秒（约 45 条）：必须全部放行。
    for (let tick = 0; tick < 45; tick += 1) {
      await execute(service, players[0].connection, {
        id: `p-${tick}`,
        type: "room.requestSync",
        payload: {},
      });
      advanceTime(220);
    }
  });
});
