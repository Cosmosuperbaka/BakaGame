import { AppError } from "../../domain/Errors";
import type {
  ConnectionRecord,
  PlayerRecord,
  RoomRecord,
} from "../../domain/Model";
import { normalizeName } from "../../domain/Rules";
import type { LogEntry } from "../../infrastructure/EventLogger";
import type { ClientMessage } from "../../shared/Index";
import {
  type CommandHandler,
  ownsCommand,
  unsupportedCommand,
} from "./CommandHandler";

export const PLAYER_COMMAND_TYPES = [
  "player.rename",
  "player.setSpectator",
  "player.setReady",
] as const satisfies readonly ClientMessage["type"][];

interface PlayerCommandDependencies {
  now(): number;
  requireRoomPlayer(connection: ConnectionRecord): {
    room: RoomRecord;
    player: PlayerRecord;
  };
  ensureUniqueName(room: RoomRecord, name: string, exceptPlayerId?: string): void;
  isRoundActive(room: RoomRecord): boolean;
  normalizeRoleConfig(room: RoomRecord): void;
  touchRoom(room: RoomRecord): void;
  log(entry: LogEntry): Promise<void>;
  publishRoomState(room: RoomRecord): void;
  publishLobby(): void;
}

const renamePlayer = async (
  dependencies: PlayerCommandDependencies,
  connection: ConnectionRecord,
  nextName: string,
) => {
  const { room, player } = dependencies.requireRoomPlayer(connection);
  const normalized = normalizeName(nextName);

  if (!normalized) {
    throw new AppError("INVALID_NAME", "用户名不能为空");
  }

  if (player.name === normalized) {
    return { name: player.name };
  }

  dependencies.ensureUniqueName(room, normalized, player.id);
  player.name = normalized;
  player.lastSeenAt = dependencies.now();
  dependencies.touchRoom(room);

  await dependencies.log({
    type: "player.renamed",
    createdAt: dependencies.now(),
    roomId: room.id,
    playerId: player.id,
    payload: { name: player.name },
  });

  dependencies.publishRoomState(room);
  return { name: player.name };
};

const setSpectator = async (
  dependencies: PlayerCommandDependencies,
  connection: ConnectionRecord,
  spectator: boolean,
) => {
  // 阵营切换只允许发生在局外，避免游戏中角色池被动态篡改。
  const { room, player } = dependencies.requireRoomPlayer(connection);

  if (player.membership === "kicked") {
    throw new AppError("PLAYER_KICKED", "该玩家已被移出房间");
  }

  if (dependencies.isRoundActive(room)) {
    throw new AppError("ROUND_ACTIVE", "游戏进行中无法切换阵营");
  }

  if (spectator && !room.settings.allowSpectators) {
    throw new AppError("SPECTATOR_DISABLED", "当前房间不允许旁观");
  }

  player.membership = spectator ? "spectator" : "active";
  player.isReady = false;
  dependencies.normalizeRoleConfig(room);
  dependencies.touchRoom(room);

  await dependencies.log({
    type: "player.membership_changed",
    createdAt: dependencies.now(),
    roomId: room.id,
    playerId: player.id,
    payload: { membership: player.membership },
  });

  dependencies.publishRoomState(room);
  dependencies.publishLobby();
  return { membership: player.membership };
};

const setReady = async (
  dependencies: PlayerCommandDependencies,
  connection: ConnectionRecord,
  ready: boolean,
) => {
  const { room, player } = dependencies.requireRoomPlayer(connection);

  if (dependencies.isRoundActive(room)) {
    throw new AppError("ROUND_ACTIVE", "游戏进行中无法切换准备状态");
  }

  player.isReady = ready;
  dependencies.touchRoom(room);

  await dependencies.log({
    type: "player.ready_changed",
    createdAt: dependencies.now(),
    roomId: room.id,
    playerId: player.id,
    payload: { ready },
  });

  dependencies.publishRoomState(room);
  return { ready };
};

export const createPlayerCommandHandler = (
  dependencies: PlayerCommandDependencies,
): CommandHandler => ({
  canHandle: (type) => ownsCommand(PLAYER_COMMAND_TYPES, type),
  execute: (connection, message) => {
    switch (message.type) {
      case "player.rename":
        return renamePlayer(dependencies, connection, message.payload.name);
      case "player.setSpectator":
        return setSpectator(dependencies, connection, message.payload.spectator);
      case "player.setReady":
        return setReady(dependencies, connection, message.payload.ready);
      default:
        return unsupportedCommand();
    }
  },
});
