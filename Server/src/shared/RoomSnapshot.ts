import { GAME_IDS } from "./Protocol";

/**
 * 房间快照的落盘契约（服务端内部使用，不下发给客户端）。
 *
 * 只校验信封，不逐字段校验房间记录：快照是自己写自己读的，不是外部输入；
 * 逐字段 schema 反而会在新增可选字段时把本可恢复的房间拒掉 —— CEE 侧已有同类教训
 * （可恢复状态不得交 schema 拒绝）。房间级护栏放在各服务的恢复入口，坏房间单条跳过。
 */

/**
 * 落盘格式版本：与代码里的常量不一致时整份丢弃。
 * 这条判断必须放在解析房间之前 —— 否则部署新版本后会在恢复中途抛错，
 * 表现为「服务起得来但一个房间都没有」，且日志里看不到原因。
 */
export const ROOM_SNAPSHOT_VERSION = 1;

/** 快照按游戏分文件：同一份代码会被多个容器挂载共享，合在一起会互相恢复影子房间。 */
export const ROOM_SNAPSHOT_GAMES = GAME_IDS;

export type RoomSnapshotGame = (typeof ROOM_SNAPSHOT_GAMES)[number];

/** 快照信封：一次写入的完整内容，`savedAt` 是恢复时做时间平移的唯一依据。 */
export interface RoomSnapshotEnvelope {
  v: number;
  savedAt: number;
  game: RoomSnapshotGame;
  rooms: unknown[];
}

/** 房间记录的最小可恢复形状：没有 id 就无法定位，直接丢弃；其余字段由各游戏自己定义。 */
export interface SnapshottedRoom {
  id: string;
  [field: string]: unknown;
}

export const isRoomSnapshotGame = (value: string): value is RoomSnapshotGame =>
  (ROOM_SNAPSHOT_GAMES as readonly string[]).includes(value);

/** 解析逗号分隔的片角色配置；未知取值由调用方拒绝，这里只做切分与去重。 */
export const parseRoomSnapshotGames = (raw: string): string[] => [
  ...new Set(
    raw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  ),
];
