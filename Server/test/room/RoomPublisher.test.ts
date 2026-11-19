import { describe, expect, test } from "bun:test";

import { publishRoomState, type RoomFrames } from "../../src/application/room/RoomPublisher";
import type { ConnectionRecord } from "../../src/shared/Model";
import { makeConnection, makeSeat, type KernelSeat } from "./RoomKernelFixtures";

const seats = new Map<string, KernelSeat>([
  ["a", makeSeat("a")],
  ["b", makeSeat("b")],
  ["g", makeSeat("g", { membership: "spectator" })],
]);
const seatOf = (connection: ConnectionRecord) =>
  connection.playerId ? seats.get(connection.playerId) : undefined;

const seated = (id: string, playerId?: string) =>
  makeConnection(id, { overrides: { roomId: "1234", playerId } });

/** 构造一份帧来源并记下被调用的次数：快照只构造一次，投影按旁观与否二选一。 */
const createFrames = (options: { skipSeatless?: boolean } = {}) => {
  const counts = { snapshot: 0, privateFor: [] as string[] };
  const full = { view: "full" };
  const main = { view: "main" };
  const frames: RoomFrames<KernelSeat> = {
    snapshotEvent: "song.room.snapshot",
    privateEvent: "song.game.privateState",
    snapshotFor: (seat) => {
      counts.snapshot += 1;
      if (!seat && options.skipSeatless) return undefined;
      return seat?.membership === "spectator" ? full : main;
    },
    privateFor: (seat) => {
      counts.privateFor.push(seat.id);
      return { playerId: seat.id };
    },
  };
  return { frames, counts, full, main };
};

describe("快照扇出", () => {
  test("每条连接先公共帧后私有帧；没有座位的连接只收公共帧", () => {
    const { frames, main } = createFrames();
    const [a, watcher] = [seated("c1", "a"), seated("c2")];
    publishRoomState([a, watcher], seatOf, frames, "state");
    expect(a.sent).toEqual([
      { type: "event", event: "song.room.snapshot", payload: main },
      { type: "event", event: "song.game.privateState", payload: { playerId: "a" } },
    ]);
    expect(watcher.sent).toEqual([{ type: "event", event: "song.room.snapshot", payload: main }]);
  });

  test("同一份投影的公共帧只封一次包：连续观看者共用同一个帧对象，换投影才新建", () => {
    const { frames, full } = createFrames();
    const [a, b, g] = [seated("c1", "a"), seated("c2", "b"), seated("c3", "g")];
    publishRoomState([a, b, g], seatOf, frames, "state");
    expect(b.sent[0]).toBe(a.sent[0]);
    expect(g.sent[0]).not.toBe(a.sent[0]);
    expect((g.sent[0] as { payload: unknown }).payload).toBe(full);
  });

  test("投影返回 undefined 的连接整条跳过，不收任何帧", () => {
    const { frames, counts } = createFrames({ skipSeatless: true });
    const [a, stray] = [seated("c1", "a"), seated("c2")];
    publishRoomState([a, stray], seatOf, frames, "state");
    expect(stray.sent).toEqual([]);
    expect(counts.privateFor).toEqual(["a"]);
  });

  test("校准模式走校准出口，与正常发布共用同一份帧口径", () => {
    const { frames } = createFrames();
    const a = seated("c1", "a");
    publishRoomState([a], seatOf, frames, "calibration");
    expect(a.sent).toEqual([]);
    publishRoomState([a], seatOf, frames, "state");
    expect(a.calibrations).toEqual(a.sent);
  });

  test("没有校准出口的连接在校准模式下静默跳过", () => {
    const { frames } = createFrames();
    const bare = seated("c1", "a");
    delete bare.sendStateSyncCalibration;
    expect(() => publishRoomState([bare], seatOf, frames, "calibration")).not.toThrow();
    expect(bare.sent).toEqual([]);
  });
});
