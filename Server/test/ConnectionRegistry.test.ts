import { describe, expect, test } from "bun:test";

import { ConnectionRegistry } from "../src/application/ConnectionRegistry";
import { AppError } from "../src/domain/Errors";
import type { ConnectionRecord } from "../src/domain/Model";

const createConnection = (
  id: string,
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord => ({
  id,
  lobbySubscribed: false,
  send: () => {},
  close: () => {},
  ...overrides,
});

describe("ConnectionRegistry", () => {
  test("注册、查询和注销连接会保持统计一致", () => {
    const registry = new ConnectionRegistry();
    const connection = createConnection("conn-1", { lobbySubscribed: true });

    registry.registerConnection(connection);

    expect(registry.getConnection("conn-1")).toBe(connection);
    expect(registry.findConnection("conn-1")).toBe(connection);
    expect(registry.stats).toEqual({ totalConnections: 1, lobbySubscribers: 1 });
    expect(registry.unregisterConnection("conn-1")).toBe(connection);
    expect(registry.unregisterConnection("conn-1")).toBeUndefined();
    expect(registry.stats).toEqual({ totalConnections: 0, lobbySubscribers: 0 });
  });

  test("查询不存在的连接会抛出稳定的业务错误", () => {
    const registry = new ConnectionRegistry();
    let captured: unknown;

    try {
      registry.getConnection("missing");
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(AppError);
    expect((captured as AppError).code).toBe("CONNECTION_NOT_FOUND");
  });

  test("大厅订阅者与房间连接互斥筛选", () => {
    const registry = new ConnectionRegistry();
    const lobby = createConnection("lobby", { lobbySubscribed: true });
    const roomMember = createConnection("room", {
      lobbySubscribed: true,
      roomId: "1234",
      playerId: "player-1",
    });
    const idle = createConnection("idle");
    registry.registerConnection(lobby);
    registry.registerConnection(roomMember);
    registry.registerConnection(idle);

    expect(registry.getLobbySubscribers()).toEqual([lobby]);
    expect(registry.getRoomConnections("1234")).toEqual([roomMember]);
    expect(registry.findConnectionByPlayer("1234", "player-1")).toBe(roomMember);
    expect(registry.findConnectionByPlayer("5678", "player-1")).toBeUndefined();
    expect(registry.findConnectionByPlayerId("player-1")).toBe(roomMember);
  });

  test("单个连接发送失败不会阻断其余广播", () => {
    const registry = new ConnectionRegistry();
    const delivered: Array<{ id: string; payload: unknown }> = [];
    const failing = createConnection("failing", {
      roomId: "1234",
      send: () => {
        throw new Error("offline");
      },
    });
    const healthy = createConnection("healthy", {
      roomId: "1234",
      send: (payload) => delivered.push({ id: "healthy", payload }),
    });
    const otherRoom = createConnection("other", {
      roomId: "5678",
      send: (payload) => delivered.push({ id: "other", payload }),
    });
    registry.registerConnection(failing);
    registry.registerConnection(healthy);
    registry.registerConnection(otherRoom);

    registry.broadcastToRoom("1234", { event: "room-update" });

    expect(delivered).toEqual([
      { id: "healthy", payload: { event: "room-update" } },
    ]);
  });

  test("全局广播会尝试发送给每条已注册连接", () => {
    const registry = new ConnectionRegistry();
    const delivered: string[] = [];
    registry.registerConnection(
      createConnection("first", { send: () => delivered.push("first") }),
    );
    registry.registerConnection(
      createConnection("second", { send: () => delivered.push("second") }),
    );

    registry.broadcastToAll({ type: "server.shutdown" });

    expect(delivered).toEqual(["first", "second"]);
  });
});
