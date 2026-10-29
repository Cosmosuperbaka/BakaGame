import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  restoreRoomSnapshots,
  saveRoomSnapshots,
  type RoomSnapshotService,
} from "../src/application/RoomSnapshots";
import { SNAPSHOT_MAX_DOWNTIME_MS } from "../src/config/Constants";
import { RoomSnapshotStore } from "../src/infrastructure/RoomSnapshotStore";
import type { SnapshottedRoom } from "../src/shared/RoomSnapshot";

const stores: RoomSnapshotStore[] = [];
const dirs: string[] = [];

const store = (): RoomSnapshotStore => {
  const dir = mkdtempSync(join(tmpdir(), "bakagame-snapshots-"));
  dirs.push(dir);
  const created = new RoomSnapshotStore({ directory: dir });
  stores.push(created);
  return created;
};

afterEach(() => {
  for (const item of stores.splice(0)) item.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fakeService = (rooms: SnapshottedRoom[] = [{ id: "1001" }]) => {
  const calls: Array<{ rooms: readonly SnapshottedRoom[]; savedAt: number }> = [];
  const service: RoomSnapshotService = {
    exportSnapshots: () => rooms,
    restoreSnapshots: (restored, savedAt) => {
      calls.push({ rooms: restored, savedAt });
      return restored.length;
    },
  };
  return { service, calls };
};

describe("房间快照编排", () => {
  test("只保存与恢复片角色内的游戏", () => {
    const snapshotStore = store();
    const faker = fakeService();
    const cee = fakeService();
    const song = fakeService();
    const targets = {
      store: snapshotStore,
      games: ["faker"] as const,
      services: { faker: faker.service, song: song.service, cee: cee.service },
    };

    expect(saveRoomSnapshots(targets, 1_000).saved).toEqual({ faker: 1 });
    // 未列入片角色的游戏不写盘，读回时也不会碰它们。
    expect(snapshotStore.load("cee")).toBeUndefined();

    const summary = restoreRoomSnapshots({ ...targets, now: () => 1_000 });
    expect(summary.restored).toEqual({ faker: 1 });
    expect(faker.calls).toHaveLength(1);
    expect(cee.calls).toHaveLength(0);
    expect(song.calls).toHaveLength(0);
  });

  test("停机超过上限时丢弃快照，不交给服务恢复", () => {
    const snapshotStore = store();
    const faker = fakeService();
    const targets = {
      store: snapshotStore,
      games: ["faker"] as const,
      services: { faker: faker.service, song: fakeService().service, cee: fakeService().service },
    };
    saveRoomSnapshots(targets, 1_000);

    const late = restoreRoomSnapshots({
      ...targets,
      now: () => 1_000 + SNAPSHOT_MAX_DOWNTIME_MS + 1,
    });
    expect(late.discarded).toEqual(["faker"]);
    expect(late.restored).toEqual({});
    expect(faker.calls).toHaveLength(0);
    // 丢弃同样算消费：过期快照不会在下一次启动里卷土重来。
    expect(snapshotStore.load("faker")).toBeUndefined();

    saveRoomSnapshots(targets, 1_000);
    const inTime = restoreRoomSnapshots({
      ...targets,
      now: () => 1_000 + SNAPSHOT_MAX_DOWNTIME_MS - 1,
    });
    expect(inTime.discarded).toEqual([]);
    expect(inTime.restored).toEqual({ faker: 1 });
  });

  test("恢复即消费：恢复后再次非优雅重启不会把同一份旧快照再恢复一次", () => {
    const snapshotStore = store();
    const faker = fakeService();
    const targets = {
      store: snapshotStore,
      games: ["faker"] as const,
      services: { faker: faker.service, song: fakeService().service, cee: fakeService().service },
    };
    saveRoomSnapshots(targets, 1_000);

    expect(restoreRoomSnapshots({ ...targets, now: () => 2_000 }).restored).toEqual({ faker: 1 });
    // 恢复后进程被强杀（没有优雅停机写新快照），下一次启动仍在可恢复窗口内。
    expect(restoreRoomSnapshots({ ...targets, now: () => 3_000 }).restored).toEqual({});
    expect(faker.calls).toHaveLength(1);
  });

  test("单款恢复抛错不影响其余游戏", () => {
    const snapshotStore = store();
    const faker = fakeService();
    const thrower: RoomSnapshotService = {
      exportSnapshots: () => [{ id: "2001" }],
      restoreSnapshots: () => {
        throw new Error("boom");
      },
    };
    const targets = {
      store: snapshotStore,
      games: ["faker", "cee"] as const,
      services: { faker: faker.service, cee: thrower, song: fakeService().service },
    };
    saveRoomSnapshots(targets, 1_000);

    const summary = restoreRoomSnapshots({ ...targets, now: () => 2_000 });
    expect(summary.restored).toEqual({ faker: 1, cee: 0 });
  });

  test("没有快照时什么都不做", () => {
    const summary = restoreRoomSnapshots({
      store: store(),
      games: ["faker", "song", "cee"],
      services: {
        faker: fakeService().service,
        song: fakeService().service,
        cee: fakeService().service,
      },
      now: () => 1_000,
    });
    expect(summary).toEqual({ restored: {}, discarded: [] });
  });
});
