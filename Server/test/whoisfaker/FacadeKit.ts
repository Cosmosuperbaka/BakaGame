import { WhoIsFakerService } from "../../src/application/WhoIsFakerService";
import type { WhoIsFakerServiceOptions } from "../../src/application/whoisfaker/Options";
import { EventLogger, type LogEntry } from "../../src/infrastructure/EventLogger";
import type {
  WhoIsFakerClientMessage,
  WhoIsFakerRoomSnapshot,
  WhoIsFakerRoomRecord,
} from "../../src/shared/Index";
import { TEST_ROOMS_ON } from "../TestRoomPolicy";
import {
  createConnection,
  execute,
  getEventPayloads,
  getLastEventPayload,
  type TestConnection,
} from "../Helpers";

/** 带记录日志器与可控时钟的服务：断言日志事件、警告与错误都从这里取。 */
export const createWorld = (extra: Partial<WhoIsFakerServiceOptions> = {}) => {
  let now = Date.UTC(2026, 3, 10, 0, 0, 0);
  const entries: LogEntry[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  class RecordingLogger extends EventLogger {
    override async write(entry: LogEntry): Promise<void> {
      entries.push(entry);
      await super.write(entry);
    }
    override warn(message: string, context?: Record<string, unknown>) {
      warns.push(message);
      super.warn(message, context);
    }
    override error(message: string, context?: Record<string, unknown>) {
      errors.push(message);
      super.error(message, context);
    }
  }
  let lobbyFlush: { at: number; flush: () => void } | undefined;
  const drain = () => {
    if (!lobbyFlush || lobbyFlush.at > now) return;
    const timer = lobbyFlush;
    lobbyFlush = undefined;
    timer.flush();
  };
  const service = new WhoIsFakerService({
    testRooms: TEST_ROOMS_ON,
    now: () => now,
    random: { nextInt: (maxExclusive: number) => Math.max(maxExclusive - 1, 0) },
    eventLogger: new RecordingLogger(),
    lobbyFanoutSchedule: (flush, delayMs) => {
      lobbyFlush = { at: now + delayMs, flush };
    },
    ...extra,
  });
  return {
    service,
    entries,
    warns,
    errors,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
      drain();
    },
    logs: (type: string) => entries.filter((entry) => entry.type === type),
    room: (id: string): WhoIsFakerRoomRecord => service.rooms.get(id)!,
  };
};

export type World = ReturnType<typeof createWorld>;

export const connect = (world: World, id: string): TestConnection =>
  createConnection(world.service, id);

export const send = (world: World, conn: TestConnection, message: WhoIsFakerClientMessage) =>
  execute(world.service, conn, message);

/** 命令被拒时的错误码；没被拒返回 undefined。 */
export const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

export const errorOf = async (
  promise: Promise<unknown>
): Promise<{ code?: string; message?: string } | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error as { code?: string; message?: string };
  }
};

export const snapshotOf = (conn: TestConnection) =>
  getLastEventPayload<WhoIsFakerRoomSnapshot>(conn, "room.snapshot");

export const snapshotCount = (conn: TestConnection) =>
  getEventPayloads<WhoIsFakerRoomSnapshot>(conn, "room.snapshot").length;

/** 大厅订阅者：窗口已过的下一次变更会立即下发，所以断言前先把时钟拨过合并窗。 */
export const lobbyFrames = (conn: TestConnection) =>
  getEventPayloads<unknown[]>(conn, "lobby.rooms").length;

export const subscribeLobby = async (world: World, id = "lobby") => {
  const conn = connect(world, id);
  await send(world, conn, { id: `sub-${id}`, type: "lobby.subscribeRooms", payload: {} });
  return conn;
};

export interface Seat {
  conn: TestConnection;
  id: string;
  token: string;
}

export const makeRoom = async (
  world: World,
  roomId: string,
  extra: Record<string, unknown> = {}
): Promise<Seat> => {
  const conn = connect(world, `${roomId}-host`);
  const result = (await send(world, conn, {
    id: `${roomId}-create`,
    type: "room.create",
    payload: {
      roomId,
      name: `${roomId}房`,
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
      ...extra,
    },
  } as WhoIsFakerClientMessage)) as { playerId: string; sessionToken: string };
  return { conn, id: result.playerId, token: result.sessionToken };
};

export const joinAs = async (
  world: World,
  roomId: string,
  name: string,
  extra: Record<string, unknown> = {}
): Promise<Seat> => {
  const conn = connect(world, `${roomId}-${name}`);
  const result = (await send(world, conn, {
    id: `${roomId}-join-${name}`,
    type: "room.join",
    roomId,
    payload: { userName: name, ...extra },
  } as WhoIsFakerClientMessage)) as { playerId: string; sessionToken: string };
  return { conn, id: result.playerId, token: result.sessionToken };
};

/** 开局到描述阶段：房主 + n 名玩家，最后一名玩家出题（词语苹果与香蕉）。 */
export const startRound = async (world: World, roomId: string, players = 4) => {
  const host = await makeRoom(world, roomId);
  const others: Seat[] = [];
  for (let i = 0; i < players; i += 1) others.push(await joinAs(world, roomId, `玩家${i + 1}`));
  for (const seat of [host, ...others]) {
    await send(world, seat.conn, {
      id: `ready-${seat.id}`,
      type: "player.setReady",
      payload: { ready: true },
    });
  }
  await send(world, host.conn, { id: "start", type: "game.advancePhase", payload: {} });
  const questioner = others[others.length - 1];
  await send(world, host.conn, {
    id: "assign",
    type: "game.assignQuestioner",
    payload: { playerId: questioner.id },
  });
  await send(world, questioner.conn, {
    id: "words",
    type: "game.submitWords",
    payload: { words: ["苹果", "香蕉"] },
  });
  return { host, others, questioner, speakers: [host, ...others.slice(0, -1)] };
};

/** 让大厅合并窗走完：先排空挂着的尾沿，再把时钟拨过窗口，之后的下一次变更会立即下发。 */
export const settleLobby = (world: World) => {
  world.advance(60_000);
  world.advance(60_000);
};
