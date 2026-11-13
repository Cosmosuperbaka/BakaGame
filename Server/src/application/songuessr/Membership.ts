import { AppError } from "../../domain/Errors";
import { ensureRoomId, normalizeWord } from "../../domain/Rules";
import { assertTextAllowed } from "../../infrastructure/SensitiveText";
import { describeError } from "../../infrastructure/EventLogger";
import type { ConnectionRecord, SonGuessrClientMessage } from "../../shared/Index";
import { createEvent } from "../../transport/Packets";
import { reassignHost, transferHost } from "../room/HostPolicy";
import { requireAdminRoom } from "../room/RoomSummaries";
import {
  assertAgentAdmission,
  assertSeatResumable,
  bindSeat,
  findSeat,
  markSeatOffline,
} from "../room/SeatBinding";
import { tabSeatId } from "../TabSeat";
import type { SonGuessrContext } from "./Context";
import { clearMusicSession } from "./MusicAuth";
import { withSongAccount } from "./MusicPool";
import {
  DEFAULT_SETTINGS,
  cloneSettings,
  roomRuntime,
  type SonGuessrPlayerRecord,
  type SonGuessrRoomRecord,
} from "./Records";
import {
  appendSystemMessage,
  createPlayer,
  getRoom,
  isTestRoom,
  requireName,
  requireRoomPlayer,
  type SongCommandAt,
} from "./RoomAccess";
import { closeRoom } from "./RoomClosure";
import { SONG_ROOM_SHAPE } from "./RoomShape";
import { buildPrivateState, buildRoomSnapshot } from "./RoomViews";
import { finishRound, isRoundComplete } from "./RoundEngine";
import { releasePendingSubmitter } from "./RoundFlow";
import { ensureRoundPlayerState } from "./RoundParticipants";

export async function createRoom(
  ctx: SonGuessrContext,
  connection: ConnectionRecord,
  payload: Extract<SonGuessrClientMessage, { type: "song.room.create" }>["payload"]
) {
  const roomId = ensureRoomId(payload.roomId, ctx.testRooms);
  assertTextAllowed(payload.name, payload.userName);
  // 算摘要要跨一次 await：先同步占号挡住并发建房，房间对象在摘要算完、连接复核通过之前
  // 不进房间表，入房、大厅与巡检都看不到没有摘要的私密房。
  const release = ctx.reservations.hold(roomId, (id) => ctx.rooms.has(id));
  try {
    const password =
      payload.visibility === "private" ? ctx.passwords.require(payload.password) : undefined;

    const player = createPlayer(
      ctx,
      payload.userName,
      true,
      false,
      tabSeatId(connection, "song", roomId)
    );
    if (connection.isAgent === true) player.isAgent = true;
    const now = ctx.now();
    const solo = payload.solo === true;
    const room: SonGuessrRoomRecord = {
      id: roomId,
      name: normalizeWord(payload.name),
      solo,
      visibility: payload.visibility,
      allowSpectators: solo ? false : payload.allowSpectators,
      hostPlayerId: player.id,
      settings: cloneSettings({
        ...DEFAULT_SETTINGS,
        questionMode: solo ? "automatic" : DEFAULT_SETTINGS.questionMode,
        allowAgents: payload.allowAgents === true || connection.agentDriven?.() === true,
      }),
      phase: "waiting",
      roundNumber: 0,
      players: { [player.id]: player },
      chat: [],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      recentSongIds: [],
      recentSubjectIds: [],
    };

    if (password) room.passwordHash = await ctx.passwords.hash(password);
    // 摘要期间连接可能已经断开：断开后再登记会留下一个没有连接的在线房主，房间永远不空。
    if (!ctx.connections.findConnection(connection.id))
      throw new AppError("SESSION_INVALID", "连接状态已经变化，请重新加入");
    // 目标校验全部通过后才解绑旧席位：被拒绝的建房不得销毁原绑定。
    ensureConnectionFree(ctx, connection);
    ctx.rooms.set(roomId, room);
    attachConnection(ctx, room, player, connection);
    appendSystemMessage(ctx, room, `${player.name} 创建了房间`);
    ctx.publishRoom(room);
    ctx.publishLobby();
    ctx.log("song.room.created", room.id, player.id);
    return {
      roomId,
      playerId: player.id,
      sessionToken: player.sessionToken,
      snapshot: buildRoomSnapshot(ctx, room),
      privateState: buildPrivateState(ctx, room, player),
    };
  } finally {
    release();
  }
}

export async function joinRoom(
  ctx: SonGuessrContext,
  connection: ConnectionRecord,
  roomIdValue: string | undefined,
  payload: Extract<SonGuessrClientMessage, { type: "song.room.join" }>["payload"]
) {
  const room = getRoom(ctx, ensureRoomId(roomIdValue ?? "", ctx.testRooms));
  // 同一张标签页再次加入就是回到原座位：已经进过门，不重复核对口令，也不会与自己撞名。
  const seat = findSeat(ctx.kernel, room, connection);
  if (seat) return resumeSeat(ctx, connection, room, seat);
  if (room.solo) throw new AppError("SOLO_ROOM_FORBIDDEN", "单人房间不接受其他玩家加入");
  assertAgentAdmission(connection, SONG_ROOM_SHAPE.admission(room));
  await ctx.passwords.verify(room, room.visibility, payload.password, connection.id);
  // 比对摘要要跨一次 await，期间房间可能已关闭：写入前先确认拿到的还是登记中的那一份。
  if (ctx.rooms.get(room.id) !== room) throw new AppError("ROOM_NOT_FOUND", "房间已经关闭");
  const name = requireName(payload.userName);
  if (
    Object.values(room.players).some(
      (player) => player.name === name && player.membership !== "kicked"
    )
  ) {
    throw new AppError("NAME_CONFLICT", "该用户名已在房间中");
  }

  const membership = room.phase === "waiting" ? "active" : "spectator";
  if (membership === "spectator" && !room.allowSpectators) {
    throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
  }

  // 目标校验全部通过后才解绑旧席位：密码错误、房号不存在等拒绝不得销毁原绑定。
  ensureConnectionFree(ctx, connection);
  const player = createPlayer(ctx, name, false, false, tabSeatId(connection, "song", room.id));
  if (connection.isAgent === true) player.isAgent = true;
  player.membership = membership;
  room.players[player.id] = player;
  attachConnection(ctx, room, player, connection);
  ctx.touch(room);
  appendSystemMessage(ctx, room, `${player.name} 加入了房间`);
  ctx.publishRoom(room);
  ctx.publishLobby();
  ctx.log("song.room.joined", room.id, player.id);
  return {
    roomId: room.id,
    playerId: player.id,
    sessionToken: player.sessionToken,
    snapshot: buildRoomSnapshot(ctx, room),
    privateState: buildPrivateState(ctx, room, player),
  };
}

export async function reconnectRoom(
  ctx: SonGuessrContext,
  connection: ConnectionRecord,
  roomIdValue: string,
  token: string
) {
  const targetRoomId = ensureRoomId(roomIdValue, ctx.testRooms);
  const room = getRoom(ctx, targetRoomId);
  ensureAgentsAllowed(room, connection);

  const player = findSeat(ctx.kernel, room, connection, token);
  if (!player) throw new AppError("SESSION_INVALID", "会话令牌无效");

  return resumeSeat(ctx, connection, room, player);
}

/** 把连接接回既有席位：重连与同标签页再次加入共用，准入判定只有这一份。 */
async function resumeSeat(
  ctx: SonGuessrContext,
  connection: ConnectionRecord,
  room: SonGuessrRoomRecord,
  player: SonGuessrPlayerRecord
) {
  assertSeatResumable(player, connection);

  // 同一条连接重连它本来就在的那个座位时，不能走 detachFromRoom：
  // 那会先把自己的 player 记录删掉，随后的按 token 查找必然落空，重连反而失败。
  // 换房或换座重连则要等目标房号与令牌都校验通过后再释放旧席位：绑定座位的前提是连接空闲。
  if (!(connection.roomId === room.id && connection.playerId === player.id)) {
    ensureConnectionFree(ctx, connection);
  }

  // 房主空缺时回座的人当场接任：重选只挑在线的人，空缺期间回来的人不会再有第二次机会。
  attachConnection(ctx, room, player, connection);
  // 不能留给发布时的视图兜底：下面刷新播放地址要等一次 await，期间别人的操作会判
  // 「本回合是否已结束」，缺状态的人会被当成已作答完毕而提前收回合。
  ensureRoundPlayerState(ctx, room, player);

  // 网易云播放地址可能带有效期。刷新页面后重新取一次当前回合地址，
  // 只替换 URL，不改动已经固定的答案、歌词片段和回合状态。
  const activeRound = room.phase === "playing" ? room.currentRound : undefined;
  if (activeRound) {
    try {
      const refreshedSong = await withSongAccount(
        ctx,
        room,
        activeRound.song.id,
        (cookie) => ctx.options.musicProvider.getSong(activeRound.song.id, cookie),
        {
          requireVip:
            activeRound.song.id.startsWith("qq:") && activeRound.song.requiresVip === true,
        }
      );
      if (room.phase === "playing" && room.currentRound === activeRound) {
        // 换新对象而不是原地改：provider 可能返回自己缓存/复用的歌曲对象。
        activeRound.song = { ...activeRound.song, audioUrl: refreshedSong.audioUrl };
      }
    } catch (error) {
      // 地址刷新失败不应阻止玩家恢复席位，记录 warning 告警并允许客户端尝试现有地址。
      ctx.options.eventLogger?.warn("重连刷新歌曲播放地址失败", {
        roomId: room.id,
        songId: activeRound.song.id,
        ...describeError(error),
      });
    }
  }
  ctx.touch(room);
  ctx.publishRoom(room);
  ctx.publishLobby();
  return {
    roomId: room.id,
    playerId: player.id,
    sessionToken: player.sessionToken,
    snapshot: buildRoomSnapshot(ctx, room),
    privateState: buildPrivateState(ctx, room, player),
  };
}

export function leaveRoom(ctx: SonGuessrContext, { connection }: SongCommandAt) {
  // 显式离开代表账号主动退出：号跟着人一起撤掉。
  return detachFromRoom(ctx, connection);
}

/**
 * 让连接与其当前席位彻底脱钩，并与房间内的 player 记录同步，避免出现
 * 「在线但没有任何连接」的幽灵玩家（onlineCount 永不归零 → 房间永不关闭 →
 * 4 位房间号被耗尽，且只能靠重启进程恢复）。
 *
 * 离开房间一律撤掉自己贡献的号：账号池的定义就是「在房且开关打开者的账号」，
 * 人走了号必须跟着走，否则旧房里会长期挂着一份没有人认领的凭据。网络断线不走这里，
 * 由离线宽限期处理（宽限内号仍在，超期连人带号一起清）。
 */
function detachFromRoom(ctx: SonGuessrContext, connection: ConnectionRecord) {
  const { room, player } = requireRoomPlayer(ctx, connection);
  clearMusicSession(ctx, room, player.id);
  delete room.players[player.id];
  ctx.connections.detach(connection);

  if (Object.keys(room.players).length === 0 && !isTestRoom(ctx, room)) {
    closeRoom(ctx, room, "empty");
    return { left: true, roomClosed: true };
  }

  if (room.hostPlayerId === player.id) reassignRemovedHost(room);
  releasePendingSubmitter(
    ctx,
    room,
    player.id,
    `${player.name} 离开房间，出题已中止，请重新指定出题人`
  );
  if (room.phase === "playing" && isRoundComplete(ctx, room)) finishRound(ctx, room);

  ctx.touch(room);
  appendSystemMessage(ctx, room, `${player.name} 离开了房间`);
  ctx.publishRoom(room);
  ctx.publishLobby();
  return { left: true, roomClosed: false };
}

export function kick(ctx: SonGuessrContext, at: SongCommandAt, targetPlayerId: string) {
  const { room, seat: player } = at;
  if (targetPlayerId === player.id) throw new AppError("INVALID_TARGET", "房主不能踢出自己");
  const target = room.players[targetPlayerId];
  if (!target || target.membership === "kicked")
    throw new AppError("PLAYER_NOT_FOUND", "玩家不存在");
  kickPlayer(ctx, room, target);
  return { kicked: true };
}

/** 房主踢人与后台移人共用；后台可能移走房主，此时按掉线口径重选房主。 */
function kickPlayer(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  target: SonGuessrPlayerRecord
) {
  clearMusicSession(ctx, room, target.id);
  target.membership = "kicked";
  target.online = false;
  const targetConnection = ctx.connections.findConnectionByPlayer(room.id, target.id);
  if (targetConnection) {
    (targetConnection.sendPacket ?? targetConnection.send)(
      createEvent("song.room.kicked", { roomId: room.id })
    );
    ctx.connections.detach(targetConnection);
    targetConnection.close(4003, "kicked");
  }

  releasePendingSubmitter(ctx, room, target.id, `出题人 ${target.name} 已被移出，请重新指定出题人`);
  if (room.hostPlayerId === target.id) reassignRemovedHost(room);
  if (room.phase === "playing" && isRoundComplete(ctx, room)) finishRound(ctx, room);
  ctx.touch(room);
  ctx.publishRoom(room);
  ctx.publishLobby();
}

export function transferHostCommand(
  ctx: SonGuessrContext,
  at: SongCommandAt,
  targetPlayerId: string
) {
  const { room } = at;
  const target = room.players[targetPlayerId];
  const previousHostId = room.hostPlayerId;
  transferHost(room, target);
  settleHostChange(room, previousHostId);
  ctx.touch(room);
  ctx.publishRoom(room);
  return { hostPlayerId: room.hostPlayerId };
}

export async function disconnectSeat(ctx: SonGuessrContext, connectionId: string): Promise<void> {
  const connection = ctx.connections.unregisterConnection(connectionId);
  if (!connection?.roomId || !connection.playerId) return;
  const room = ctx.rooms.get(connection.roomId);
  const player = room?.players[connection.playerId];
  if (!room || !player) return;

  ctx.connections.detach(connection);
  if (player.connectionId !== connection.id) return;

  // 断线不是显式离开：保留房主身份和房间音乐会话，给移动端后台重连留出时间。
  markSeatOffline(ctx.kernel, room, player, { emptyRoomExempt: isTestRoom(ctx, room) });
  releasePendingSubmitter(
    ctx,
    room,
    player.id,
    `${player.name} 断线，出题已中止，请重新指定出题人`
  );
  // 普通断线可能只是刷新或切到后台，不能因此把仍在进行的回合提前结算。
  // 显式离开和踢出会移除正式席位，并在各自路径重新检查回合完成状态。
  ctx.touch(room);
  ctx.publishRoom(room);
  ctx.publishLobby();
  ctx.log("song.player.disconnected", room.id, player.id);
}

/** 把连接绑到座位；内核可能在绑定时改选房主，易主后的猜歌收尾在这里统一做。 */
function attachConnection(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  player: SonGuessrPlayerRecord,
  connection: ConnectionRecord
) {
  const previousHostId = room.hostPlayerId;
  bindSeat(ctx.kernel, room, player, connection);
  settleHostChange(room, previousHostId);
}

function ensureConnectionFree(ctx: SonGuessrContext, connection: ConnectionRecord) {
  if (!connection.roomId && !connection.playerId) return;
  if (connection.roomId && connection.playerId && ctx.rooms.has(connection.roomId)) {
    detachFromRoom(ctx, connection);
    return;
  }
  // 房间已经不存在（或只有一半字段有值）时，requireRoomPlayer 会抛 ROOM_NOT_FOUND
  // 并把正常的 create / join / reconnect 一起打断；这种残余状态退回原来的置空即可。
  ctx.connections.detach(connection);
}

function ensureAgentsAllowed(room: SonGuessrRoomRecord, connection: ConnectionRecord) {
  if (connection.isAgent === true && room.settings.allowAgents !== true) {
    throw new AppError("AGENTS_NOT_ALLOWED", "房主已禁止 Agent 进入");
  }
}

/**
 * 房主易主后的猜歌收尾：新房主恒为已准备；开局加载在途时作废那次开局的操作，
 * 它回来复核会发现自己已不是当前操作。登录锁按「人 + 平台」记账，与房主身份无关，不碰。
 */
export function settleHostChange(room: SonGuessrRoomRecord, previousHostId: string) {
  if (room.hostPlayerId === previousHostId) return;
  const host = room.players[room.hostPlayerId];
  if (!host) return;
  roomRuntime(room).automaticRoundOperation = undefined;
  roomRuntime(room).automaticRoundLoading = false;
  host.isReady = true;
}

/** 房主被移除（离开、被踢、被清理）后按内核规则改选；没有在线真人时房主待选。 */
export function reassignRemovedHost(room: SonGuessrRoomRecord) {
  const previousHostId = room.hostPlayerId;
  reassignHost(room, Object.values(room.players));
  settleHostChange(room, previousHostId);
}

export async function adminKickPlayer(
  ctx: SonGuessrContext,
  roomId: string,
  playerId: string
): Promise<void> {
  const room = requireAdminRoom(ctx.rooms, roomId);
  const target = room.players[playerId];
  if (!target || target.membership === "kicked")
    throw new AppError("PLAYER_NOT_FOUND", "玩家不存在");
  kickPlayer(ctx, room, target);
}
