import { describe, expect, test } from "bun:test";
import type { AgentGameClient } from "../src/mcp/GameClient";
import { auditTarget, routeRpc, type RpcHandlers } from "../src/mcp/Rpc";
import { COMMAND_TIMEOUT_MS, GAME_COMMAND_TIMEOUT_MS } from "../src/mcp/Timeouts";
import { SeatUi } from "../src/mcp/ui/SeatUi";
import { baseFakerSnapshot } from "./McpFixtures";

/** 把路由的每个出口记成字符串，用例直接断言走了哪条。 */
const recording = (answers: RpcHandlers<string>["answers"]): RpcHandlers<string> => ({
  answers,
  silent: () => "silent",
  reply: (result) => `reply:${JSON.stringify(result)}`,
  fail: (code, message) => `fail:${code}:${message}`,
  initialize: () => "initialize",
  listTools: () => "listTools",
  callTool: () => "callTool",
});

describe("方法路由", () => {
  test("通知不回响应，初始化总是进入握手", () => {
    const handlers = recording(() => true);
    expect(routeRpc("notifications/initialized", 1, {}, handlers)).toBe("silent");
    expect(routeRpc("notifications/cancelled", undefined, {}, handlers)).toBe("silent");
    expect(routeRpc("initialize", undefined, undefined, handlers)).toBe("initialize");
  });

  test("要不要回响应由传输声明：不回时一律静默", () => {
    const quiet = recording(() => false);
    for (const method of ["ping", "server/discover", "tools/list", "tools/call", "nope"])
      expect(routeRpc(method, undefined, {}, quiet)).toBe("silent");

    const loud = recording(() => true);
    expect(routeRpc("ping", 1, {}, loud)).toBe("reply:{}");
    expect(routeRpc("tools/list", 1, {}, loud)).toBe("listTools");
    expect(routeRpc("tools/call", 1, {}, loud)).toBe("callTool");
    expect(routeRpc("resources/list", 1, {}, loud)).toBe(
      "fail:-32601:不支持的方法：resources/list"
    );
    expect(routeRpc(5, 1, {}, loud)).toBe("fail:-32601:不支持的方法：5");
  });

  test("握手之外的方法把询问的方法与 id 原样交给传输判断", async () => {
    const asked: Array<[unknown, unknown]> = [];
    const handlers = recording((method, id) => {
      asked.push([method, id]);
      return true;
    });
    await routeRpc("ping", null, {}, handlers);
    expect(asked).toEqual([["ping", null]]);
  });
});

describe("审计目标", () => {
  const client = {
    currentRoom: (game: string) => (game === "cee" ? "9999" : undefined),
  } as unknown as AgentGameClient;

  test("显式游戏与房号优先；推断只在入口声明时才按已入房的唯一游戏补全", () => {
    expect(auditTarget(client, { game: "cee", action: "click" }, false)).toEqual({
      action: "click",
      game: "cee",
      roomId: "9999",
    });
    expect(auditTarget(client, {}, false)).toEqual({
      action: undefined,
      game: undefined,
      roomId: undefined,
    });
    expect(auditTarget(client, {}, true)).toMatchObject({ game: "cee", roomId: "9999" });
    expect(auditTarget(client, { roomId: "1234", game: "song" }, true).roomId).toBe("1234");
  });
});

describe("命令超时表", () => {
  test("三款游戏的屏幕命令各取表里的值，值保持历史取值", async () => {
    expect(GAME_COMMAND_TIMEOUT_MS).toEqual({
      faker: COMMAND_TIMEOUT_MS,
      song: 180_000,
      cee: 120_000,
    });

    const seen: Array<[string, unknown]> = [];
    const open = (game: "faker" | "song" | "cee", snapshot: Record<string, unknown>) => {
      const client = {
        currentRoom: () => String(snapshot.roomId),
        currentPlayerId: () => "p1",
        currentSnapshot: () => snapshot,
        currentPrivateState: () => ({ playerId: "p1", canStart: true }),
        sendInRoom: async (target: string, type: string, _payload: unknown, options?: unknown) => {
          seen.push([
            `${target}:${type}`,
            (options as { timeoutMs?: number } | undefined)?.timeoutMs,
          ]);
          return { ok: true };
        },
        stateVersion: () => 0,
        waitForStateChange: async () => true,
      } as unknown as AgentGameClient;
      return new SeatUi(client, { pacing: false }).run(game, [
        { action: "click", control: `${game === "faker" ? "faker" : game}.ready` },
      ]);
    };

    const players = [
      { id: "p1", name: "我", membership: "active", isHost: false, isReady: false, ready: false },
    ];
    await open("faker", { ...baseFakerSnapshot("waiting"), hostPlayerId: "p9", players });
    await open("song", {
      roomId: "1",
      phase: "waiting",
      hostPlayerId: "p9",
      players,
      settings: {},
    });
    await open("cee", { roomId: "1", phase: "waiting", hostPlayerId: "p9", players, settings: {} });
    expect(seen).toEqual([
      ["faker:player.setReady", COMMAND_TIMEOUT_MS],
      ["song:song.player.setReady", 180_000],
      ["cee:cee.player.ready", 120_000],
    ]);
  });
});
