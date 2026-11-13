import { SONGUESSR_LOBBY_ROOMS_EVENT, type ConnectionRecord } from "../../shared/Index";
import {
  MUSIC_AUTH_RATE_LIMIT_PER_CONNECTION,
  MUSIC_AUTH_RATE_LIMIT_WINDOW_MS,
  MUSIC_RATE_LIMIT_PER_CONNECTION,
  MUSIC_RATE_LIMIT_WINDOW_MS,
  SUBJECT_IMAGE_RATE_LIMIT_PER_CONNECTION,
  SUBJECT_IMAGE_RATE_LIMIT_WINDOW_MS,
} from "./Records";
import { TEST_ROOMS_DISABLED, type TestRoomPolicy } from "../../domain/TestRooms";
import type { RandomSource } from "../../domain/Rules";
import { SlidingWindowRateLimiter } from "../../infrastructure/RateLimiter";
import { createEvent } from "../../transport/Packets";
import { NOOP_GAME_RECORDER, type GameRecorder } from "../../domain/GameRecord";
import { ConnectionRegistry } from "../ConnectionRegistry";
import { LobbyFanout } from "../LobbyFanout";
import { ChatLimiter } from "../room/ChatLog";
import { IdCounter } from "../room/IdCounter";
import { RoomIdReservations } from "../room/RoomIdReservations";
import { RoomPasswordGate } from "../room/RoomPasswordGate";
import type { SeatBindingContext, TabSeatContext } from "../room/SeatBinding";
import { publishRoomState } from "../room/RoomPublisher";
import type { SonGuessrServiceOptions } from "./Options";
import type { SonGuessrPlayerRecord, SonGuessrRoomRecord } from "./Records";
import { buildPrivateState, buildRoomSnapshot, listRoomSummaries } from "./RoomViews";
import { SONG_ROOM_SHAPE } from "./RoomShape";

/** 口令只去首尾空白；摘要绑定规范化后的值，建房、改设置与入房必须同一口径。 */
export const normalizeRoomPassword = (password: string): string => password.trim();

/**
 * 猜歌上下文：只放数据与叶子工具（房间表、连接登记、时钟、随机源、发号器、配额、发布与日志）。
 * 玩法行为是以它为第一个参数的自由函数；子模块拿上下文而不是整个服务门面，
 * 下层模块因此不会反向依赖上层。
 */
export interface SonGuessrContext {
  readonly options: SonGuessrServiceOptions;
  readonly rooms: Map<string, SonGuessrRoomRecord>;
  readonly connections: ConnectionRegistry;
  readonly now: () => number;
  readonly random: RandomSource;
  readonly testRooms: TestRoomPolicy;
  /** 只回收本玩法发的前缀；会话令牌与标签页座位号不落进来。 */
  readonly ids: IdCounter;
  /**
   * 按连接统计的音乐上游调用配额。
   *
   * `NeteaseMusicProvider` 是全进程单例（并发 3 / 队列 64），退避虽然按出口作用域隔离，
   * 没有按连接的配额时，一个人仍会先把本进程的并发与队列打满，搜歌与出题一起排队。
   */
  readonly musicLimiter: SlidingWindowRateLimiter;
  /** 番剧封面补图的独立额度：封面请求量大而便宜，不与搜歌、取歌抢同一桶。 */
  readonly subjectImageLimiter: SlidingWindowRateLimiter;
  /** 三条音乐登录命令共用的按连接额度：登录上游要求不高频重复调用。 */
  readonly musicAuthLimiter: SlidingWindowRateLimiter;
  /** 聊天频率配额：每条聊天都会触发全房广播，不限流等于放大 DoS。额度取公共常量。 */
  readonly chatLimiter: ChatLimiter;
  /**
   * 每个房间在等号的请求。所有可用号都达到单号并发上限时在这里排队，任一租约归还
   * 或池子变化即唤醒重试；只在进程内，房间关闭时整段丢弃。
   */
  readonly musicPoolWaiters: Map<string, Set<() => void>>;
  nextMusicRefreshSweepAt: number;
  musicRefreshSweepInFlight: boolean;
  /** 座位绑定、转离线与标签页座位共用的内核上下文。 */
  readonly kernel: SeatBindingContext<SonGuessrRoomRecord, SonGuessrPlayerRecord> &
    TabSeatContext<SonGuessrRoomRecord, SonGuessrPlayerRecord> & { recorder: GameRecorder };
  /** 建房与入房、改设置共用的口令门（规范化、摘要、校验与限流）。 */
  readonly passwords: RoomPasswordGate;
  /** 建房期间的房号占用：占号与「房间可见」分开，登记进房间表之前没有人看得到半成品房间。 */
  readonly reservations: RoomIdReservations;
  /** 大厅列表的唯一出口：合并窗内的多次变更并为一次全量下发，订阅者单独取当前列表。 */
  readonly lobby: LobbyFanout;
  touch(room: SonGuessrRoomRecord): void;
  /** 向房间内全部连接（或只向指定连接）发布公共快照与各自的私有态。 */
  publishRoom(room: SonGuessrRoomRecord, targetConnection?: ConnectionRecord): void;
  publishLobby(): void;
  log(type: string, roomId?: string, playerId?: string, payload?: unknown): void;
}

export const createSonGuessrContext = (options: SonGuessrServiceOptions): SonGuessrContext => {
  const now = options.now ?? (() => Date.now());
  const rooms = new Map<string, SonGuessrRoomRecord>();
  const connections = new ConnectionRegistry();
  const ctx: SonGuessrContext = {
    options,
    rooms,
    connections,
    now,
    random: options.random ?? {
      nextInt: (maxExclusive) => Math.floor(Math.random() * Math.max(1, maxExclusive)),
    },
    testRooms: options.testRooms ?? TEST_ROOMS_DISABLED,
    ids: new IdCounter(/^song_(?:chat|guess|player)_([0-9a-z]+)$/),
    musicLimiter: new SlidingWindowRateLimiter({
      windowMs: MUSIC_RATE_LIMIT_WINDOW_MS,
      maxRequests: MUSIC_RATE_LIMIT_PER_CONNECTION,
    }),
    subjectImageLimiter: new SlidingWindowRateLimiter({
      windowMs: SUBJECT_IMAGE_RATE_LIMIT_WINDOW_MS,
      maxRequests: SUBJECT_IMAGE_RATE_LIMIT_PER_CONNECTION,
    }),
    musicAuthLimiter: new SlidingWindowRateLimiter({
      windowMs: MUSIC_AUTH_RATE_LIMIT_WINDOW_MS,
      maxRequests: MUSIC_AUTH_RATE_LIMIT_PER_CONNECTION,
    }),
    chatLimiter: new ChatLimiter({ now: () => now() }),
    kernel: {
      shape: SONG_ROOM_SHAPE,
      connections,
      rooms,
      now: () => now(),
      recorder: options.gameRecorder ?? NOOP_GAME_RECORDER,
    },
    passwords: new RoomPasswordGate({
      now: () => now(),
      normalize: normalizeRoomPassword,
      missingOnCreate: { code: "PASSWORD_REQUIRED", message: "私密房间需要密码" },
      missingOnJoin: { code: "PASSWORD_INCORRECT", message: "房间密码错误" },
      hasher: options.passwordHasher,
    }),
    reservations: new RoomIdReservations(),
    musicPoolWaiters: new Map(),
    nextMusicRefreshSweepAt: 0,
    musicRefreshSweepInFlight: false,
    lobby: new LobbyFanout({
      event: SONGUESSR_LOBBY_ROOMS_EVENT,
      now,
      broadcast: (payload) => ctx.connections.broadcastToLobby(payload),
      summaries: () => listRoomSummaries(ctx),
      schedule: options.lobbyFanoutSchedule,
    }),
    touch: (room) => {
      room.updatedAt = now();
      room.lastActivityAt = now();
    },
    publishRoom: (room, targetConnection) =>
      fanOutRoom(
        ctx,
        room,
        targetConnection ? [targetConnection] : ctx.connections.getRoomConnections(room.id),
        "state"
      ),
    publishLobby: () => ctx.lobby.request(),
    log: (type, roomId, playerId, payload) => {
      void options.eventLogger?.write({ type, roomId, playerId, payload, createdAt: now() });
    },
  };
  return ctx;
};

/** 巡检时的校准发布：与正常发布共用帧来源，只是让客户端重新对齐时钟。 */
export const publishRoomCalibration = (ctx: SonGuessrContext, room: SonGuessrRoomRecord) => {
  fanOutRoom(ctx, room, ctx.connections.getRoomConnections(room.id), "calibration");
};

/** 只给某个玩家推一份私有态（不动公共快照）。 */
export const publishPrivateState = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  player: SonGuessrPlayerRecord
) => {
  const connection = ctx.connections.findConnectionByPlayer(room.id, player.id);
  connection?.send(createEvent("song.game.privateState", buildPrivateState(ctx, room, player)));
};

/** 快照与私有态扇出：正常发布与校准共用同一份帧来源，公共快照每次发布只构造一次。 */
const fanOutRoom = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  targets: readonly ConnectionRecord[],
  mode: "state" | "calibration"
) => {
  const snapshot = buildRoomSnapshot(ctx, room);
  publishRoomState(
    targets,
    (connection) => (connection.playerId ? room.players[connection.playerId] : undefined),
    {
      snapshotEvent: SONG_ROOM_SHAPE.events.snapshot,
      privateEvent: SONG_ROOM_SHAPE.events.privateState,
      snapshotFor: () => snapshot,
      privateFor: (player) => buildPrivateState(ctx, room, player),
    },
    mode
  );
};
