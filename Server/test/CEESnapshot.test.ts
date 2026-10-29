import { afterEach, describe, expect, test } from "bun:test";
import { ceeTestHarness } from "./CEENativeFixtures";
import type { SnapshottedRoom } from "../src/shared/RoomSnapshot";

const active: ReturnType<typeof ceeTestHarness>[] = [];
const harness = () => {
  const result = ceeTestHarness();
  active.push(result);
  return result;
};
afterEach(() => {
  active.splice(0).forEach((test) => test.service.close());
});

/** 与落盘同口径：快照要经过一次 JSON 往返，`Map` 没摊平就会在这里变成空对象。 */
const throughDisk = (rooms: SnapshottedRoom[]): SnapshottedRoom[] =>
  JSON.parse(JSON.stringify(rooms)) as SnapshottedRoom[];

describe("CEE 房间快照", () => {
  test("对局中导出、经磁盘往返后由新进程恢复：座位、次数、猜测与冻结的答案都还在", async () => {
    const before = harness();
    const host = await before.create();
    const guest = await before.join("玩家");
    await before.configure(host, {});
    await before.ready(guest);
    await before.send(host, "cee.game.start", {});
    // 夹具的随机源恒取第一个候选，答案是 1 号角色；先猜错一次留下进度。
    await before.guess(guest, 3);
    expect(before.snapshot(host).players.map((player) => player.attempts)).toEqual([0, 1]);

    const rooms = throughDisk(before.service.exportSnapshots());
    const after = harness();
    expect(after.service.restoreSnapshots(rooms, before.now())).toBe(1);

    const back = after.connect("玩家回来");
    await after.send(back, "cee.room.reconnect", { roomId: "1234", sessionToken: guest.token! });
    expect(back.id).toBe(guest.id);
    const restored = after.snapshot(back);
    expect(restored.phase).toBe(before.snapshot(host).phase);
    expect(restored.players.map((player) => player.attempts)).toEqual([0, 1]);
    expect(after.privateState(back).guesses).toHaveLength(1);

    // 答案冻结在快照里：恢复后猜中原答案即获胜，而不是被重新抽题。
    await after.guess(back, 1);
    expect(after.snapshot(back).roundSummary!.winners[0].playerId).toBe(guest.id!);
  });

  test("停机时长不计入作答时限：截止时刻按暂停时长整体后移", async () => {
    const before = harness();
    const host = await before.create();
    const guest = await before.join("玩家");
    await before.configure(host, { timeLimit: 30, nonstopMode: true });
    await before.ready(guest);
    await before.send(host, "cee.game.start", {});
    const savedAt = before.now();
    const rooms = throughDisk(before.service.exportSnapshots());

    const after = harness();
    // 停机 20 秒后恢复；若截止时刻不后移，再过 15 秒（距开局 35 秒）就已超时扣次。
    after.advance(20_000);
    after.service.restoreSnapshots(rooms, savedAt);
    const back = after.connect("房主回来");
    await after.send(back, "cee.room.reconnect", { roomId: "1234", sessionToken: host.token! });
    after.advance(15_000);
    expect(after.snapshot(back).players.map((player) => player.attempts)).toEqual([0, 0]);
  });
});
