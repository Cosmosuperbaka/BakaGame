import { describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@bakagame/shared";
import type { CommandPolicy, GameWs } from "@/lib/GameWs";
import type { SendOptions } from "@/lib/WebsocketClient";
import { deferred } from "@/test/Deferred";
import { createRoomRuntime, type RoomIdentity, type RoomRuntimeOptions } from "./RoomRuntime";

type Receipt = { roomId: string; sessionToken: string; previousToken?: string | null };
type Snapshot = { roomId: string; name: string };
type Private = { sessionToken: string };
type Commands = {
  "room.requestSync": { payload: Record<string, unknown>; ack: Record<string, unknown> };
  "room.join": { payload: Record<string, unknown>; ack: Receipt };
  "room.leave": { payload: Record<string, unknown>; ack: Record<string, unknown> };
};

/** 断连接会同步派发一次断线状态：清理顺序的差异只有这样才能被观察到。 */
function createSocket() {
  const messages = new Set<(message: ServerMessage) => void>();
  const statuses = new Set<(connected: boolean) => void>();
  const sent: Array<{ type: string; payload: unknown; options?: SendOptions }> = [];
  const ws: GameWs<Commands> = {
    connect: vi.fn(),
    disconnect: vi.fn(() => statuses.forEach((handler) => handler(false))),
    waitForConnection: vi.fn(),
    send: vi.fn(async (type, payload, options) => {
      sent.push({ type, payload, options });
      return {} as never;
    }),
    onMessage: (handler) => {
      messages.add(handler);
      return () => messages.delete(handler);
    },
    onStatus: (handler) => {
      statuses.add(handler);
      return () => statuses.delete(handler);
    },
  };
  return {
    ws,
    sent,
    subscriptions: () => ({ messages: messages.size, statuses: statuses.size }),
    emitStatus: (connected: boolean) => statuses.forEach((handler) => handler(connected)),
    emit: (event: string, payload: unknown) =>
      messages.forEach((handler) => handler({ type: "event", event, payload } as ServerMessage)),
  };
}

function setup(
  knobs: {
    generationOn?: "disconnect" | "everyStatus";
    disconnectFirst?: boolean;
    policy?: CommandPolicy<Commands>;
    identity?: RoomIdentity;
  } = {}
) {
  const socket = createSocket();
  const tokens = { read: vi.fn(() => null), save: vi.fn(), clear: vi.fn() };
  const calls = {
    apply: vi.fn(),
    discard: vi.fn<(receipt: Receipt) => Promise<void>>(),
    write: vi.fn(),
    lobbyRooms: vi.fn(),
    snapshot: vi.fn(),
    privateState: vi.fn(),
    roomEnded: vi.fn(),
    shutdown: vi.fn(),
    finish: vi.fn(),
  };
  const options: RoomRuntimeOptions<Commands, Snapshot, Private, Receipt> = {
    ws: socket.ws,
    policy: knobs.policy,
    tokens,
    requestSync: "room.requestSync",
    identity: () => knobs.identity ?? { roomId: null, sessionToken: null },
    events: {
      lobbyRooms: "lobby.rooms",
      snapshot: "room.snapshot",
      privateState: "game.privateState",
      ended: { "room.closed": "房间已关闭", "session.replaced": (payload) => payload.reason ?? "" },
      extra: { "room.expiring": () => calls.lobbyRooms("expiring") },
    },
    entry: {
      apply: (receipt, context) => calls.apply(receipt, context.sync.snapshot.baseline()),
      discard: (receipt) => calls.discard(receipt),
    },
    status: {
      generationOn: knobs.generationOn ?? "disconnect",
      syncOn: "resetOnConnect",
      write: calls.write,
      subscribeLobby: () => {},
      restore: { by: "page" },
    },
    cleanup: {
      disconnectFirst: knobs.disconnectFirst ?? false,
      bumpGeneration: true,
      finish: calls.finish,
    },
    handlers: {
      lobbyRooms: calls.lobbyRooms,
      snapshot: calls.snapshot,
      privateState: calls.privateState,
      roomEnded: calls.roomEnded,
      shutdown: calls.shutdown,
    },
  };
  return { runtime: createRoomRuntime(options), socket, tokens, calls };
}

const snapshotPayload = (name: string) => ({
  mode: "full",
  revision: 1,
  state: { roomId: "1234", name },
});

describe("房间运行时骨架", () => {
  it("重复初始化不叠加第二路订阅，清理后可以重新初始化", () => {
    const { runtime, socket } = setup();
    const first = runtime.init();
    const second = runtime.init();
    expect(socket.subscriptions()).toEqual({ messages: 1, statuses: 1 });
    expect(socket.ws.connect).toHaveBeenCalledOnce();
    second();
    expect(socket.subscriptions()).toEqual({ messages: 1, statuses: 1 });
    first();
    expect(socket.subscriptions()).toEqual({ messages: 0, statuses: 0 });
    const again = runtime.init();
    expect(socket.subscriptions()).toEqual({ messages: 1, statuses: 1 });
    again();
    expect(runtime.isInitialized()).toBe(false);
  });

  it("先退订阅再断连接：清理派发的断线不再被处理", () => {
    const { runtime, socket, calls } = setup({ disconnectFirst: false });
    const dispose = runtime.init();
    socket.emitStatus(true);
    calls.write.mockClear();
    dispose();
    expect(calls.write).not.toHaveBeenCalled();
    expect(calls.finish).toHaveBeenCalledOnce();
  });

  it("先断连接再退订阅：清理派发的断线仍被处理", () => {
    const { runtime, socket, calls } = setup({ disconnectFirst: true });
    const dispose = runtime.init();
    socket.emitStatus(true);
    calls.write.mockClear();
    dispose();
    expect(calls.write).toHaveBeenCalledWith(false);
    expect(calls.finish).toHaveBeenCalledOnce();
  });

  it("断线加代次：在途入房作废，晚到 ACK 不安装也不发旧离房", async () => {
    const { runtime, socket, calls } = setup({ generationOn: "disconnect" });
    const dispose = runtime.init();
    const ack = deferred<Receipt>();
    const joined = runtime.enter(() => ack.promise).catch((error: unknown) => error);
    socket.emitStatus(false);
    ack.resolve({ roomId: "1234", sessionToken: "late-token" });
    expect(await joined).toMatchObject({ name: "AbortError" });
    expect(calls.apply).not.toHaveBeenCalled();
    // 席位随旧连接消失，往新连接发旧凭据的退房只会换来一次拒绝。
    expect(calls.discard).not.toHaveBeenCalled();
    dispose();
  });

  it("只在断线时加代次：重连不作废在途入房", async () => {
    const { runtime, socket, calls } = setup({ generationOn: "disconnect" });
    const dispose = runtime.init();
    const ack = deferred<Receipt>();
    socket.ws.send = vi.fn(() => ack.promise as never);
    const joined = runtime.enter(() => ack.promise);
    socket.emitStatus(true);
    ack.resolve({ roomId: "1234", sessionToken: "token" });
    await joined;
    expect(calls.apply).toHaveBeenCalledOnce();
    expect(calls.discard).not.toHaveBeenCalled();
    dispose();
  });

  it("每次状态变化都加代次：重连同样作废在途入房", async () => {
    const { runtime, socket, calls } = setup({ generationOn: "everyStatus" });
    const dispose = runtime.init();
    const ack = deferred<Receipt>();
    socket.ws.send = vi.fn(() => ack.promise as never);
    const joined = runtime.enter(() => ack.promise).catch((error: unknown) => error);
    socket.emitStatus(true);
    ack.resolve({ roomId: "1234", sessionToken: "token" });
    expect(await joined).toMatchObject({ name: "AbortError" });
    expect(calls.apply).not.toHaveBeenCalled();
    // 代次前进说明连接已经换了一条：旧席位随旧连接消失，不再往新连接发旧凭据的退房。
    expect(calls.discard).not.toHaveBeenCalled();
    dispose();
  });

  it("入房在途的快照只进基线，ACK 时一次交给玩法", async () => {
    const { runtime, socket, calls } = setup();
    const dispose = runtime.init();
    const ack = deferred<Receipt>();
    const joined = runtime.enter(() => ack.promise);
    socket.emit("room.snapshot", snapshotPayload("暂存名"));
    expect(calls.snapshot).not.toHaveBeenCalled();
    ack.resolve({ roomId: "1234", sessionToken: "token" });
    await joined;
    expect(calls.apply).toHaveBeenCalledWith(
      { roomId: "1234", sessionToken: "token" },
      { roomId: "1234", name: "暂存名" }
    );
    socket.emit("room.snapshot", {
      mode: "patch",
      baseRevision: 1,
      revision: 2,
      operations: [{ op: "replace", path: "/name", value: "落定名" }],
    });
    expect(calls.snapshot).toHaveBeenCalledWith(
      { roomId: "1234", name: "落定名" },
      { roomId: "1234", name: "暂存名" }
    );
    dispose();
  });

  it("结束事件指向别的房间时只清那间的凭据", () => {
    const { runtime, socket, tokens, calls } = setup({
      identity: { roomId: "1111", sessionToken: "current" },
    });
    const dispose = runtime.init();
    socket.emit("room.closed", { roomId: "2222" });
    expect(tokens.clear).toHaveBeenCalledWith("2222");
    expect(calls.roomEnded).not.toHaveBeenCalled();
    dispose();
  });

  it("结束事件清本房间凭据、作废在途入房，再交给玩法重置", async () => {
    const { runtime, socket, tokens, calls } = setup({
      identity: { roomId: "1234", sessionToken: "current" },
    });
    const dispose = runtime.init();
    const ack = deferred<Receipt>();
    const joined = runtime.enter(() => ack.promise).catch((error: unknown) => error);
    socket.emit("session.replaced", { roomId: "1234", reason: "被接管" });
    expect(tokens.clear).toHaveBeenCalledWith("1234");
    expect(calls.roomEnded).toHaveBeenCalledWith("被接管");
    ack.resolve({ roomId: "1234", sessionToken: "late" });
    expect(await joined).toMatchObject({ name: "AbortError" });
    expect(calls.discard).toHaveBeenCalledWith({ roomId: "1234", sessionToken: "late" });
    dispose();
  });

  it("停机与玩法独有事件各自路由，不落成结束事件", () => {
    const { runtime, socket, calls } = setup();
    const dispose = runtime.init();
    socket.emit("server.shutdown", { message: "重启" });
    socket.emit("room.expiring", {});
    socket.emit("lobby.rooms", []);
    expect(calls.shutdown).toHaveBeenCalledWith({ message: "重启" });
    expect(calls.lobbyRooms).toHaveBeenCalledWith("expiring");
    expect(calls.lobbyRooms).toHaveBeenCalledWith([]);
    expect(calls.roomEnded).not.toHaveBeenCalled();
    dispose();
  });

  it("命令补齐房号与令牌，超时先取调用方再取策略表", async () => {
    const { runtime, socket } = setup({
      identity: { roomId: "1234", sessionToken: "token" },
      policy: { "room.requestSync": { timeout: 0 } },
    });
    await runtime.sendCommand("room.requestSync");
    await runtime.sendCommand("room.requestSync", {}, { timeout: 5000 });
    await runtime.sendCommand("room.join", { userName: "玩家" });
    expect(socket.sent.map((entry) => entry.options)).toEqual([
      { roomId: "1234", sessionToken: "token", timeout: 0 },
      { roomId: "1234", sessionToken: "token", timeout: 5000 },
      { roomId: "1234", sessionToken: "token", timeout: undefined },
    ]);
  });
});
