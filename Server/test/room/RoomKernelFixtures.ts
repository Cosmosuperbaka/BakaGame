import { expect } from "bun:test";

import type { RoomCore, RoomShape, SeatCore } from "../../src/application/room/RoomCore";
import { isAppError } from "../../src/domain/Errors";
import type { ConnectionRecord } from "../../src/shared/Model";

/** 断言同步调用抛出指定业务错误码。 */
export const expectAppError = (run: () => unknown, code: string): void => {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(isAppError(thrown) ? thrown.code : thrown).toBe(code);
};

/** 断言异步调用以指定业务错误码拒绝。 */
export const expectAppErrorAsync = async (run: () => Promise<unknown>, code: string) => {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(isAppError(thrown) ? thrown.code : thrown).toBe(code);
};

/** 内核单测用的最小玩法：座位放 Record、准入字段放房间层，形状与猜歌一致。 */
export interface KernelSeat extends SeatCore {
  score: number;
}

export interface KernelRoom extends RoomCore {
  players: Record<string, KernelSeat>;
  visibility: "public" | "private";
  allowSpectators: boolean;
  allowAgents: boolean;
}

export const kernelShape: RoomShape<KernelRoom, KernelSeat> = {
  game: "song",
  seats: (room) => Object.values(room.players),
  seat: (room, seatId) => room.players[seatId],
  addSeat: (room, seat) => {
    room.players[seat.id] = seat;
  },
  dropSeat: (room, seatId) => {
    delete room.players[seatId];
  },
  admission: (room) => ({
    visibility: room.visibility,
    allowSpectators: room.allowSpectators,
    allowAgents: room.allowAgents,
  }),
  events: {
    snapshot: "song.room.snapshot",
    privateState: "song.game.privateState",
    closed: "song.room.closed",
    sessionReplaced: "song.session.replaced",
  },
  sessionReplacedPayload: (room) => ({ roomId: room.id }),
  sessionReplacedCloseReason: "session_replaced",
};

export const makeSeat = (id: string, overrides: Partial<KernelSeat> = {}): KernelSeat => ({
  id,
  sessionToken: `token_${id}`,
  name: id,
  membership: "active",
  online: true,
  isBot: false,
  joinedAt: 0,
  lastSeenAt: 0,
  score: 0,
  ...overrides,
});

export const makeRoom = (
  seats: KernelSeat[],
  overrides: Partial<Omit<KernelRoom, "players">> = {}
): KernelRoom => ({
  id: "1234",
  hostPlayerId: seats[0]?.id ?? "",
  chat: [],
  createdAt: 0,
  lastActivityAt: 0,
  players: Object.fromEntries(seats.map((seat) => [seat.id, seat])),
  visibility: "public",
  allowSpectators: true,
  allowAgents: false,
  ...overrides,
});

/** 记下每条出站帧的假连接；`fail` 让对应出口抛错，用来测「旧连接已经死了」。 */
export interface FakeConnection extends ConnectionRecord {
  readonly sent: unknown[];
  readonly packets: unknown[];
  readonly calibrations: unknown[];
  readonly closes: { code?: number; reason?: string }[];
  resets: number;
}

export const makeConnection = (
  id: string,
  options: {
    overrides?: Partial<ConnectionRecord>;
    fail?: { send?: boolean; close?: boolean };
  } = {}
): FakeConnection => {
  const sent: unknown[] = [];
  const packets: unknown[] = [];
  const calibrations: unknown[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const connection: FakeConnection = {
    id,
    lobbySubscribed: false,
    sent,
    packets,
    calibrations,
    closes,
    resets: 0,
    send: (payload) => {
      if (options.fail?.send) throw new Error("连接已断开");
      sent.push(payload);
    },
    sendPacket: (payload) => {
      if (options.fail?.send) throw new Error("连接已断开");
      packets.push(payload);
    },
    sendStateSyncCalibration: (payload) => {
      calibrations.push(payload);
    },
    resetStateSync: () => {
      connection.resets += 1;
    },
    close: (code, reason) => {
      if (options.fail?.close) throw new Error("连接已关闭");
      closes.push({ code, reason });
    },
    ...options.overrides,
  };
  return connection;
};
