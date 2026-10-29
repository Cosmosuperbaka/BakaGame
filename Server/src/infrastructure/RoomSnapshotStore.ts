import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  ROOM_SNAPSHOT_VERSION,
  type RoomSnapshotGame,
  type SnapshottedRoom,
} from "../shared/RoomSnapshot";

export interface RoomSnapshotStoreOptions {
  /** 存放目录；每款游戏一个文件，天然隔离共用挂载目录的多个进程。 */
  directory: string;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

/** 读取结果：`savedAt` 是这批房间的写入时刻，恢复时用于平移全部绝对时间戳。 */
export interface LoadedRoomSnapshot {
  savedAt: number;
  rooms: SnapshottedRoom[];
}

interface MetaRow {
  version: number;
  saved_at: number;
}

interface SnapshotRow {
  room_id: string;
  payload: string;
}

/**
 * 房间快照的本地存储（一款游戏一个 SQLite 文件）。
 *
 * 为什么不用远端数据库：停机保存要在「最不稳的时刻」完成，远端库一抖动就存不下来；
 * 本地文件不依赖网络。为什么按游戏分文件：同一份代码目录会被多个容器挂载共享，
 * 合用一个文件时，只接 CEE 路由的那片启动会读到主片写的房间并恢复出没人连的影子房间。
 *
 * 存储本身是增强功能，不是启动前置：打不开（权限、磁盘满、文件损坏）时整体降级为
 * no-op 并记一条 warn，服务照常起 —— 宁可这次不保存，也不能因为存不了快照让站点起不来。
 */
export class RoomSnapshotStore {
  private readonly directory: string;
  private readonly logger?: RoomSnapshotStoreOptions["logger"];
  private readonly databases = new Map<RoomSnapshotGame, Database>();
  /** 打开失败过的游戏：同进程内不再重试，避免每次保存都刷一条同样的告警。 */
  private readonly unavailable = new Set<RoomSnapshotGame>();

  constructor(options: RoomSnapshotStoreOptions) {
    this.directory = options.directory;
    this.logger = options.logger;
  }

  /** 保存一款游戏的全部房间；整体替换，已销毁的房间不会残留在上一版快照里。 */
  save(game: RoomSnapshotGame, rooms: readonly SnapshottedRoom[], savedAt: number): number {
    const db = this.database(game);
    if (!db) return 0;
    const rows: Array<[string, string]> = [];
    for (const room of rooms) {
      // 没有 id 的房间无法定位，写进去也恢复不出来。
      if (typeof room?.id !== "string" || !room.id) continue;
      try {
        rows.push([room.id, JSON.stringify(room)]);
      } catch (error) {
        // 房间记录里出现循环引用时 stringify 会抛；单房间跳过，不连累其余房间。
        this.logger?.warn("房间快照序列化失败，已跳过该房间", {
          game,
          roomId: room.id,
          error: String(error),
        });
      }
    }
    try {
      // meta 与房间行同事务写入：只写了一半的快照比没有快照更危险。
      db.transaction(() => {
        db.query(
          "INSERT INTO snapshot_meta (id, version, saved_at) VALUES (1, ?1, ?2) " +
            "ON CONFLICT(id) DO UPDATE SET version=?1, saved_at=?2"
        ).run(ROOM_SNAPSHOT_VERSION, savedAt);
        db.exec("DELETE FROM room_snapshot");
        const insert = db.query("INSERT INTO room_snapshot (room_id, payload) VALUES (?1, ?2)");
        for (const [id, payload] of rows) insert.run(id, payload);
      })();
      return rows.length;
    } catch (error) {
      this.markUnavailable(game, error);
      return 0;
    }
  }

  /** 读取最近一次快照；无快照、版本不符、文件损坏时返回 undefined。 */
  load(game: RoomSnapshotGame): LoadedRoomSnapshot | undefined {
    const db = this.database(game);
    if (!db) return undefined;
    let meta: MetaRow | null;
    let rows: SnapshotRow[];
    try {
      meta = db.query<MetaRow, []>("SELECT version, saved_at FROM snapshot_meta WHERE id=1").get();
      // 版本先于房间解析判断：跨版本反序列化会在中途抛错，日志里只剩「服务起得来但没房间」。
      if (!meta || meta.version !== ROOM_SNAPSHOT_VERSION) return undefined;
      rows = db.query<SnapshotRow, []>("SELECT room_id, payload FROM room_snapshot").all();
    } catch (error) {
      this.markUnavailable(game, error);
      return undefined;
    }
    if (!rows.length) return undefined;

    const rooms: SnapshottedRoom[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        // 单房间坏数据只丢这一间：整份放弃等于把一次成功保存全废掉。
        this.logger?.warn("房间快照解析失败，已跳过该房间", { game, roomId: row.room_id });
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const room = parsed as SnapshottedRoom;
      if (typeof room.id !== "string" || !room.id) continue;
      rooms.push(room);
    }
    if (!rooms.length) return undefined;
    return { savedAt: meta.saved_at, rooms };
  }

  /**
   * 消费掉一款游戏的快照（删房间行，load 随之返回 undefined）。
   *
   * 快照只代表「最后一次优雅停机」时的状态：恢复后若进程再被强杀、OOM 或回滚，
   * 不经优雅停机就不会写新快照，留着旧行等于把同一份旧状态再恢复一次——已结束的
   * 对局、已关的房间与旧分数全部复活。
   */
  clear(game: RoomSnapshotGame): void {
    const db = this.database(game);
    if (!db) return;
    try {
      db.exec("DELETE FROM room_snapshot");
    } catch (error) {
      this.markUnavailable(game, error);
    }
  }

  close(): void {
    for (const db of this.databases.values()) {
      try {
        db.close();
      } catch {
        // 关闭失败不影响进程退出。
      }
    }
    this.databases.clear();
  }

  private path(game: RoomSnapshotGame): string {
    return join(this.directory, `room-snapshots-${game}.sqlite`);
  }

  private database(game: RoomSnapshotGame): Database | undefined {
    const existing = this.databases.get(game);
    if (existing) return existing;
    if (this.unavailable.has(game)) return undefined;
    try {
      const path = this.path(game);
      mkdirSync(dirname(path), { recursive: true });
      const db = new Database(path, { create: true });
      // WAL 让「写到一半被 kill」也能回滚到上一个完整事务；busy_timeout 兜住偶发的并发打开。
      db.exec(`PRAGMA journal_mode=WAL;
        PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS snapshot_meta (
          id       INTEGER PRIMARY KEY CHECK (id = 1),
          version  INTEGER NOT NULL,
          saved_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS room_snapshot (
          room_id  TEXT PRIMARY KEY,
          payload  TEXT NOT NULL
        );`);
      this.databases.set(game, db);
      return db;
    } catch (error) {
      this.markUnavailable(game, error);
      return undefined;
    }
  }

  private markUnavailable(game: RoomSnapshotGame, error: unknown): void {
    if (this.unavailable.has(game)) return;
    this.unavailable.add(game);
    this.logger?.warn("房间快照存储不可用，本次不保存状态", {
      game,
      path: this.path(game),
      error: String(error),
    });
  }
}
