import type { CEECharacterView } from "../shared/Index";
import type { SnapshottedRoom } from "../shared/RoomSnapshot";
import type { CEEPlayerRecord, CEERoom, CEERound, CEEUnit } from "../domain/CEEModel";
import { adoptRoomCore, hasSnapshotShape, shiftDeadline } from "./room/RoomSnapshotCodec";

/** 摊平后的回合：三处 Map / 两处 Set 换成普通对象，其余字段原样。 */
type SerializedCEERound = Omit<
  CEERound,
  "units" | "characters" | "tagOwners" | "pendingTagOwners"
> & {
  units: Record<string, CEEUnit>;
  characters: Record<string, CEECharacterView>;
  tagOwners: Record<string, string[]>;
  pendingTagOwners: Record<string, string[]>;
};

type SerializedCEERoom = Omit<CEERoom, "players" | "spectatorRequests" | "round"> & {
  players: Record<string, CEEPlayerRecord>;
  spectatorRequests: Record<string, number>;
  round: SerializedCEERound | null;
};

const setsToRecord = (map: Map<string, Set<string>>): Record<string, string[]> =>
  Object.fromEntries([...map].map(([key, set]) => [key, [...set]]));

const recordToSets = (record: Record<string, string[]> | undefined): Map<string, Set<string>> =>
  new Map(Object.entries(record ?? {}).map(([key, list]) => [key, new Set(list)]));

/** 摊平成可序列化的形状；落盘出口与「丢弃运行时状态」由内核统一处理。 */
export const flattenRoom = (room: CEERoom): SerializedCEERoom => {
  const round: SerializedCEERound | null = room.round
    ? {
        ...room.round,
        units: Object.fromEntries(room.round.units),
        characters: Object.fromEntries(room.round.characters),
        tagOwners: setsToRecord(room.round.tagOwners),
        pendingTagOwners: setsToRecord(room.round.pendingTagOwners),
      }
    : null;
  return {
    ...room,
    players: Object.fromEntries(room.players),
    spectatorRequests: Object.fromEntries(room.spectatorRequests),
    round,
  };
};

/** 还原 Map 与 Set，截止时刻按停机时长后移；公共的「全员离线、计时重起」交给内核。 */
export const expandRoom = (
  raw: SnapshottedRoom,
  now: number,
  pausedMs: number
): CEERoom | undefined => {
  if (!hasSnapshotShape(raw)) return undefined;
  const saved = raw as unknown as SerializedCEERoom;

  const players = new Map<string, CEEPlayerRecord>();
  for (const [id, player] of Object.entries(saved.players)) players.set(id, { ...player });

  const round: CEERound | null = saved.round
    ? {
        ...saved.round,
        units: new Map(
          Object.entries(saved.round.units ?? {}).map(([id, unit]) => [
            id,
            { ...unit, deadlineAt: shiftDeadline(unit.deadlineAt, pausedMs) },
          ])
        ),
        characters: new Map(
          Object.entries(saved.round.characters ?? {}).map(([id, view]) => [Number(id), view])
        ),
        tagOwners: recordToSets(saved.round.tagOwners),
        pendingTagOwners: recordToSets(saved.round.pendingTagOwners),
      }
    : null;

  const room: CEERoom = {
    ...saved,
    players,
    spectatorRequests: new Map(
      Object.entries(saved.spectatorRequests ?? {}).map(([id, at]) => [id, Number(at)])
    ),
    // 阶段截止时刻暂停：停机期间没人能作答，按原时刻结算等于用故障惩罚玩家。
    phaseDeadlineAt: shiftDeadline(saved.phaseDeadlineAt, pausedMs),
    round,
  };
  adoptRoomCore(room, players.values(), now);
  return room;
};
