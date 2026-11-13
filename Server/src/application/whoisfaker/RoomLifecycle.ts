import { AppError } from "../../domain/Errors";
import {
  createDefaultRoleConfig,
  ensureRoomId,
  normalizeName,
  safeEqualToken,
} from "../../domain/Rules";
import { assertTextAllowed } from "../../infrastructure/SensitiveText";
import type {
  ConnectionRecord,
  RoleConfig,
  RoomSettings,
  WhoIsFakerPlayerRecord,
  WhoIsFakerRoomRecord,
} from "../../shared/Index";
import type { WhoIsFakerClientMessage } from "../../transport/WhoIsFakerProtocol";
import { tabSeatId } from "../TabSeat";
import { transferHost } from "../room/HostPolicy";
import { assertAgentAdmission, assertSeatResumable, findSeat } from "../room/SeatBinding";
import type { WhoIsFakerContext } from "./Context";
import { forceRemovePlayer } from "./ForcedRemoval";
import { handlePlayerOffline } from "./OfflineSettlement";
import { clearPendingDisconnect } from "./PendingDisconnects";
import { attachConnection } from "./RoomAttach";
import {
  ensureHost,
  ensureUniqueName,
  getRoom,
  isRoundActive,
  type WhoIsFakerSeatAt,
} from "./RoomAccess";
import { publishLobby, publishRoom } from "./RoomPublish";
import { whoIsFakerShape } from "./RoomShape";
import {
  clampRoleConfig,
  getConfigurableParticipantCount,
  normalizeRoomRoleConfig,
} from "./RoundRules";
import { finishRound } from "./RoundSettlement";
import { runBots } from "./dev/BotActors";

/** 改设置的纯校验产物：失败在产生它之前就抛出，不会留下半截设置。 */
interface SettingsPatch {
  name?: string;
  visibility?: RoomSettings["visibility"];
  allowSpectators?: boolean;
  revealRoleOnDeath?: boolean;
  spectatorsSeeAnswers?: boolean;
  allowAgents?: boolean;
  roleConfig?: RoleConfig;
  /** 需要重新算摘要的明文口令；仅最终为私密房且本次带了口令时才有。 */
  password?: string;
}

export const createRoom = async (
  ctx: WhoIsFakerContext,
  connection: ConnectionRecord,
  message: Extract<WhoIsFakerClientMessage, { type: "room.create" }>
) => {
  // 创建房间时同时把当前连接绑定为房主与首个正式玩家。
  const roomId = ensureRoomId(message.payload.roomId, ctx.testRooms);
  assertTextAllowed(message.payload.name, message.payload.userName);

  // 同步占号：占号期间同号的第二次建房被拒，而半成品房间不进房间表，入房、大厅、巡检都看不到它。
  const releaseRoomId = ctx.reservations.hold(roomId, (id) => ctx.rooms.has(id));
  let room: WhoIsFakerRoomRecord;
  let host: WhoIsFakerPlayerRecord;
  try {
    ({ room, host } = await buildAndRegisterRoom(ctx, connection, message, roomId));
  } finally {
    releaseRoomId();
  }

  const previousRoomUpdate = attachConnection(ctx, room, host, connection);
  ctx.appendSystemMessage(room, `${host.name} 创建了房间`);
  ctx.touch(room);

  await previousRoomUpdate;
  await ctx.log({
    type: "room.created",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: host.id,
    payload: {
      visibility: room.settings.visibility,
    },
  });

  publishRoom(ctx, room);
  publishLobby(ctx);

  return {
    roomId: room.id,
    playerId: host.id,
    sessionToken: host.sessionToken,
  };
};

/**
 * 构造房间并登记进房间表。私密房要跨一次 await 算口令摘要：摘要算完、复核连接仍在之后才登记，
 * 登记前任何读房间表的路径都看不到这间房，不会出现「私密却没有口令」的窗口。
 */
const buildAndRegisterRoom = async (
  ctx: WhoIsFakerContext,
  connection: ConnectionRecord,
  message: Extract<WhoIsFakerClientMessage, { type: "room.create" }>,
  roomId: string
): Promise<{ room: WhoIsFakerRoomRecord; host: WhoIsFakerPlayerRecord }> => {
  // 私密房口令只存 argon2 摘要：房间记录、快照与日志里都不该出现可读的口令。
  const password =
    message.payload.visibility === "private"
      ? ctx.passwords.require(message.payload.password)
      : undefined;

  const room: WhoIsFakerRoomRecord = {
    id: roomId,
    settings: {
      name: normalizeName(message.payload.name),
      visibility: message.payload.visibility,
      allowSpectators: message.payload.allowSpectators,
      roleConfig: createDefaultRoleConfig(),
      revealRoleOnDeath: true,
      spectatorsSeeAnswers: false,
      allowAgents: message.payload.allowAgents === true || connection.agentDriven?.() === true,
    },
    hostPlayerId: "",
    createdAt: ctx.now(),
    updatedAt: ctx.now(),
    lastActivityAt: ctx.now(),
    players: {},
    chat: [],
  };

  const host = ctx.createPlayer(
    message.payload.userName,
    false,
    connection.isAgent === true,
    tabSeatId(connection, "faker", room.id)
  );
  room.players[host.id] = host;
  room.hostPlayerId = host.id;

  // 房间名缺省时使用房主昵称，避免千篇一律的"新房间"。
  if (!room.settings.name) {
    room.settings.name = `${host.name}的房间`;
  }

  room.settings.roleConfig = clampRoleConfig(
    message.payload.roleConfig ?? createDefaultRoleConfig(),
    getConfigurableParticipantCount(room)
  );

  if (password) {
    room.passwordHash = await ctx.passwords.hash(password);
    // 算摘要期间连接可能已断开：此时再绑定会留下没有任何连接会触发离线的幽灵席位。
    if (!ctx.connectionRegistry.findConnection(connection.id)) {
      throw new AppError("CONNECTION_CLOSED", "连接已断开");
    }
  }
  ctx.rooms.set(room.id, room);
  return { room, host };
};

export const joinRoom = async (
  ctx: WhoIsFakerContext,
  connection: ConnectionRecord,
  message: Extract<WhoIsFakerClientMessage, { type: "room.join" }>
) => {
  // 开局后新连接默认只能作为旁观者进入，避免临时插入正式席位打乱本局。
  const roomId = ensureRoomId(message.roomId ?? "", ctx.testRooms);
  const room = getRoom(ctx, roomId);

  assertAgentAdmission(connection, whoIsFakerShape.admission(room));
  // 同一张标签页再次加入就是回到原座位：已经进过门，不重复核对口令，也不会与自己撞名。
  // 被踢的记录不算座位，再进来走普通加入。
  const seat = findSeat(ctx.seatContext, room, connection);
  if (seat) return resumeSeat(ctx, room, seat, connection);
  await ctx.passwords.verify(
    room,
    room.settings.visibility,
    message.payload.password,
    connection.id
  );
  // 比对摘要要跨一次 await，期间房间可能已关闭：写入前先确认拿到的还是登记中的那一份。
  if (ctx.rooms.get(room.id) !== room) throw new AppError("ROOM_NOT_FOUND", "房间不存在或已关闭");
  // 同理连接也可能在比对期间断开，已不在册就不能再占座位。
  if (!ctx.connectionRegistry.findConnection(connection.id))
    throw new AppError("CONNECTION_CLOSED", "连接已断开");
  // 同名重入不按「自己让给自己」放行：掉线席位默认保留在名册里等凭票重连，
  // 例外放行会让名册里同时留下两个同名玩家。要走接管就用 room.reconnect 的会话票据。
  assertTextAllowed(message.payload.userName);
  ensureUniqueName(room, message.payload.userName);

  const joiningAsSpectator = isRoundActive(room);

  if (joiningAsSpectator && !room.settings.allowSpectators) {
    throw new AppError("SPECTATOR_DISABLED", "当前房间不允许旁观");
  }

  const player = ctx.createPlayer(
    message.payload.userName,
    false,
    connection.isAgent === true,
    tabSeatId(connection, "faker", room.id)
  );
  player.membership = joiningAsSpectator ? "spectator" : "active";

  room.players[player.id] = player;
  const previousRoomUpdate = attachConnection(ctx, room, player, connection);
  normalizeRoomRoleConfig(room);
  ctx.appendSystemMessage(room, `${player.name} 加入了房间`);
  ctx.touch(room);

  await previousRoomUpdate;
  await ctx.log({
    type: "room.joined",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: {
      membership: player.membership,
    },
  });

  publishRoom(ctx, room);
  publishLobby(ctx);

  return {
    roomId: room.id,
    playerId: player.id,
    sessionToken: player.sessionToken,
  };
};

export const reconnectRoom = async (
  ctx: WhoIsFakerContext,
  connection: ConnectionRecord,
  message: Extract<WhoIsFakerClientMessage, { type: "room.reconnect" }>
) => {
  // 重连不会创建新玩家，只会把会话重新挂回原连接。
  const room = getRoom(ctx, ensureRoomId(message.payload.roomId, ctx.testRooms));
  ensureAgentsAllowed(room, connection);

  const player =
    Object.values(room.players).find((item) =>
      safeEqualToken(item.sessionToken, message.payload.sessionToken)
    ) ?? tabSeat(room, connection);

  if (!player) {
    throw new AppError("SESSION_NOT_FOUND", "会话凭证无效或座位已不存在");
  }

  return resumeSeat(ctx, room, player, connection);
};

/** 这张标签页在本房的席位记录；没有标签页身份的连接恒为空。 */
const tabSeat = (room: WhoIsFakerRoomRecord, connection: ConnectionRecord) => {
  const seatId = tabSeatId(connection, "faker", room.id);
  return seatId ? room.players[seatId] : undefined;
};

/** 把连接接回既有席位：重连与同标签页再次加入共用，准入判定只有这一份。 */
const resumeSeat = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord,
  connection: ConnectionRecord
) => {
  // 被踢的记录不能回来；人类的座位只属于人类的标签页，Agent 只能由人类把标签页交出来。
  assertSeatResumable(player, connection);

  return restorePlayerConnection(ctx, room, player, connection, {
    appendMessage: `${player.name} 已重新连接`,
  });
};

export const leaveRoom = async (ctx: WhoIsFakerContext, at: WhoIsFakerSeatAt) => {
  const { room, seat: player } = at;
  await handlePlayerOffline(ctx, room, player.id, "leave");

  return { left: true };
};

export const requestSync = (ctx: WhoIsFakerContext, at: WhoIsFakerSeatAt) => {
  const { room, connection } = at;
  connection.resetStateSync?.();
  publishRoom(ctx, room, connection);
  return { synced: true };
};

export const updateSettings = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  payload: Extract<WhoIsFakerClientMessage, { type: "room.updateSettings" }>["payload"]
) => {
  const { room, seat: player } = at;

  // 两阶段：纯校验产出补丁（失败不改任何状态）→ 必要时 await 慢哈希 → 复核后同步一次写入。
  // 房主与回合空闲由命令表守卫在进入前确认，await 回来后在下面按同一顺序复核。
  const patch = buildSettingsPatch(ctx, room, payload);
  const passwordHash =
    patch.password === undefined ? undefined : await ctx.passwords.hash(patch.password);

  // await 期间房间可能已被关闭、房主换人或开局，回来先复核再写（Spec §4.2）。
  if (ctx.rooms.get(room.id) !== room) {
    throw new AppError("ROOM_NOT_FOUND", "房间不存在");
  }
  assertSettingsEditable(room, player.id);
  const current = buildSettingsPatch(ctx, room, payload);
  if (current.password !== patch.password && current.password !== undefined) {
    throw new AppError("SETTINGS_CHANGED", "房间设置刚刚发生变化，请重试");
  }
  applySettingsPatch(room, current, passwordHash);

  ctx.touch(room);

  await ctx.log({
    type: "room.settings_changed",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: room.settings,
  });

  publishRoom(ctx, room);
  publishLobby(ctx);

  return {
    settings: room.settings,
  };
};

/** await 之后的复核：仍是房主、且回合没有开始；与命令表声明的守卫同序同码。 */
const assertSettingsEditable = (room: WhoIsFakerRoomRecord, playerId: string): void => {
  ensureHost(room, playerId);

  if (isRoundActive(room)) {
    throw new AppError("ROUND_ACTIVE", "游戏进行中无法修改房间设置");
  }
};

/** 校验全部字段，返回补丁；不写房间。 */
const buildSettingsPatch = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  payload: Extract<WhoIsFakerClientMessage, { type: "room.updateSettings" }>["payload"]
): SettingsPatch => {
  const patch: SettingsPatch = {
    visibility: payload.visibility ?? undefined,
    allowSpectators: payload.allowSpectators ?? undefined,
    revealRoleOnDeath: payload.revealRoleOnDeath ?? undefined,
    spectatorsSeeAnswers: payload.spectatorsSeeAnswers ?? undefined,
    allowAgents: payload.allowAgents ?? undefined,
    roleConfig: payload.roleConfig ?? undefined,
  };

  if (payload.name != null) {
    const normalized = normalizeName(payload.name);
    assertTextAllowed(normalized);

    if (!normalized) {
      throw new AppError("INVALID_ROOM_NAME", "房间名不能为空");
    }

    patch.name = normalized;
  }

  if (
    patch.allowSpectators === false &&
    Object.values(room.players).some((item) => item.membership === "spectator")
  ) {
    throw new AppError("SPECTATOR_EXISTS", "房间内仍有旁观者，无法关闭旁观");
  }

  // 公开房没有口令；私密房本次带了口令就换新，没带则沿用已有摘要，两者都没有才拒绝。
  if ((patch.visibility ?? room.settings.visibility) === "private") {
    if (payload.password != null) {
      patch.password = ctx.passwords.require(payload.password);
    } else if (!room.passwordHash) {
      throw new AppError("PASSWORD_REQUIRED", "私密房间必须设置密码");
    }
  }

  return patch;
};

/** 同步写入已通过校验的补丁；`passwordHash` 与补丁里的明文口令一一对应。 */
const applySettingsPatch = (
  room: WhoIsFakerRoomRecord,
  patch: SettingsPatch,
  passwordHash: string | undefined
): void => {
  const settings = room.settings;
  if (patch.name !== undefined) settings.name = patch.name;
  if (patch.visibility !== undefined) settings.visibility = patch.visibility;
  if (patch.allowSpectators !== undefined) settings.allowSpectators = patch.allowSpectators;
  if (patch.revealRoleOnDeath !== undefined) {
    settings.revealRoleOnDeath = patch.revealRoleOnDeath;
  }
  if (patch.spectatorsSeeAnswers !== undefined) {
    settings.spectatorsSeeAnswers = patch.spectatorsSeeAnswers;
  }
  if (patch.allowAgents !== undefined) settings.allowAgents = patch.allowAgents;

  if (settings.visibility === "public") {
    room.passwordHash = undefined;
  } else if (passwordHash !== undefined) {
    room.passwordHash = passwordHash;
  }

  if (patch.roleConfig) {
    // 人数不够时不再直接拒绝保存，而是静默夹到当前允许的范围；这样房主依然能把
    // 其它设置（房间名、私密、旁观等）改掉。前端通过 roleLimits 给出禁用提示。
    settings.roleConfig = clampRoleConfig(patch.roleConfig, getConfigurableParticipantCount(room));
  } else {
    normalizeRoomRoleConfig(room);
  }
};

export const kick = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  targetPlayerId: string
) => {
  const { room, seat: player } = at;

  if (targetPlayerId === player.id) {
    throw new AppError("INVALID_KICK", "房主不能踢出自己");
  }

  const target = room.players[targetPlayerId];

  if (!target) {
    throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在");
  }

  // 已被踢的记录只是等待清理的占位，重复踢不再重走一遍移除与日志。
  if (target.membership !== "kicked") {
    await kickPlayer(ctx, room, target, "房主");
  }
  return { playerId: target.id };
};

/** 房主踢人与后台移人共用：出题人被移出时本局中止，其余按强制移除结算。 */
export const kickPlayer = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  target: WhoIsFakerPlayerRecord,
  by: "房主" | "管理员"
) => {
  if (isRoundActive(room) && room.round?.questionerPlayerId === target.id) {
    await finishRound(ctx, room, "aborted", `出题人被${by}移出，本局中止`);
  }

  await forceRemovePlayer(ctx, room, target.id, `${by}已将其移出房间`);

  publishRoom(ctx, room);
  publishLobby(ctx);
  await runBots(ctx, room);
};

export const transferRoomHost = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  targetPlayerId: string
) => {
  // 房主手动转移：任意阶段均可，目标必须是在线的正式玩家（真人）。房主判定由命令表守卫完成。
  const { room, seat: player } = at;

  if (targetPlayerId === player.id) {
    throw new AppError("INVALID_TARGET", "不能将房主转移给自己");
  }

  const target = room.players[targetPlayerId];

  if (!target || target.membership === "kicked") {
    throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在");
  }

  transferHost(room, target);
  ctx.touch(room);
  ctx.appendSystemMessage(room, `${player.name} 将房主转移给了 ${target.name}`);

  await ctx.log({
    type: "room.host_transferred",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: { nextHostId: target.id },
  });

  publishRoom(ctx, room);
  publishLobby(ctx);
  return { hostPlayerId: target.id };
};

const restorePlayerConnection = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord,
  connection: ConnectionRecord,
  options: {
    appendMessage: string;
  }
) => {
  const previousRoomUpdate = attachConnection(ctx, room, player, connection);

  if (room.round) {
    clearPendingDisconnect(room.round, player.id);
  }

  if (room.round?.questionerPlayerId === player.id) {
    room.round.questionerReconnectDeadlineAt = undefined;
  }

  ctx.touch(room);
  ctx.appendSystemMessage(room, options.appendMessage);

  await previousRoomUpdate;
  await ctx.log({
    type: "room.reconnected",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
  });

  publishRoom(ctx, room);
  publishLobby(ctx);

  return {
    roomId: room.id,
    playerId: player.id,
    sessionToken: player.sessionToken,
  };
};

const ensureAgentsAllowed = (room: WhoIsFakerRoomRecord, connection: ConnectionRecord) => {
  if (connection.isAgent === true && room.settings.allowAgents !== true) {
    throw new AppError("AGENTS_NOT_ALLOWED", "房主已禁止 Agent 进入");
  }
};
