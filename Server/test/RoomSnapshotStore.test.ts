import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomSnapshotStore } from "../src/infrastructure/RoomSnapshotStore";
import { ROOM_SNAPSHOT_VERSION } from "../src/shared/RoomSnapshot";

const activeStores: RoomSnapshotStore[] = [];
const tempDirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "bakagame-snapshot-"));
  tempDirs.push(dir);
  return dir;
};

const create = (directory: string, logger?: { warn: () => void }): RoomSnapshotStore => {
  const store = new RoomSnapshotStore({ directory, logger });
  activeStores.push(store);
  return store;
};

afterEach(() => {
  for (const store of activeStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RoomSnapshotStore", () => {
  test("保存后能原样读回，savedAt 取写入时刻", () => {
    const store = create(tempDir());
    store.save(
      "faker",
      [
        { id: "1001", phase: "voting" },
        { id: "1002", phase: "waiting" },
      ],
      1_700_000_000_000
    );

    const loaded = store.load("faker");
    expect(loaded?.savedAt).toBe(1_700_000_000_000);
    expect(loaded?.rooms).toHaveLength(2);
    expect(loaded?.rooms).toContainEqual({ id: "1001", phase: "voting" });
  });

  test("再次保存整体替换，已销毁的房间不会残留", () => {
    const store = create(tempDir());
    store.save("faker", [{ id: "1001" }, { id: "1002" }], 1);
    store.save("faker", [{ id: "1002" }], 2);

    const loaded = store.load("faker");
    expect(loaded?.rooms.map((room) => room.id)).toEqual(["1002"]);
    expect(loaded?.savedAt).toBe(2);
  });

  test("没有快照时返回 undefined", () => {
    expect(create(tempDir()).load("song")).toBeUndefined();
  });

  test("按游戏分文件，互不覆盖", () => {
    const dir = tempDir();
    const store = create(dir);
    store.save("faker", [{ id: "1001" }], 1);
    store.save("cee", [{ id: "2002" }], 2);

    expect(store.load("faker")?.rooms).toEqual([{ id: "1001" }]);
    expect(store.load("cee")?.rooms).toEqual([{ id: "2002" }]);
    // WAL 模式会额外留下 -wal / -shm 附属文件，只比对主文件名。
    expect(
      readdirSync(dir)
        .filter((name) => name.startsWith("room-snapshots-") && name.endsWith(".sqlite"))
        .sort()
    ).toEqual(["room-snapshots-cee.sqlite", "room-snapshots-faker.sqlite"]);
  });

  test("版本不符时整份丢弃", () => {
    const dir = tempDir();
    const store = create(dir);
    store.save("faker", [{ id: "1001" }], 1);
    store.close();

    // 模拟旧版本写下的快照：版本号是唯一判据。
    const raw = new Database(join(dir, "room-snapshots-faker.sqlite"), { readwrite: true });
    raw.query("UPDATE snapshot_meta SET version=?1 WHERE id=1").run(ROOM_SNAPSHOT_VERSION + 1);
    raw.close();

    expect(create(dir).load("faker")).toBeUndefined();
  });

  test("单房间坏数据只跳过该房间", () => {
    const dir = tempDir();
    const store = create(dir);
    store.save("faker", [{ id: "1001" }, { id: "1002" }], 1);
    store.close();

    const raw = new Database(join(dir, "room-snapshots-faker.sqlite"), { readwrite: true });
    raw.query("UPDATE room_snapshot SET payload=?1 WHERE room_id=?2").run("not-json", "1002");
    raw.close();

    const loaded = create(dir).load("faker");
    expect(loaded?.rooms).toEqual([{ id: "1001" }]);
  });

  test("跳过没有 id 的房间", () => {
    const store = create(tempDir());
    const saved = store.save("faker", [{ id: "" } as { id: string }, { id: "1001" }], 1);
    expect(saved).toBe(1);
    expect(store.load("faker")?.rooms).toEqual([{ id: "1001" }]);
  });

  test("目录不存在时自动创建", () => {
    const dir = join(tempDir(), "nested", "snapshots");
    const store = create(dir);
    store.save("song", [{ id: "1001" }], 1);
    expect(store.load("song")?.rooms).toEqual([{ id: "1001" }]);
  });
});
