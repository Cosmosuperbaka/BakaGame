import { AppError } from "../../domain/Errors";
import { NOOP_GAME_RECORDER, type GameRecorder } from "../../domain/GameRecord";
import { normalizeName, normalizeWord, type RandomSource } from "../../domain/Rules";
import { TEST_ROOMS_DISABLED, type TestRoomPolicy } from "../../domain/TestRooms";
import { describeError, type LogEntry } from "../../infrastructure/EventLogger";
import {
  WHOISFAKER_LOBBY_ROOMS_EVENT,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { ConnectionRegistry } from "../ConnectionRegistry";
import { LobbyFanout } from "../LobbyFanout";
import { ChatLimiter, appendChat, systemMessage } from "../room/ChatLog";
import { IdCounter } from "../room/IdCounter";
import { RoomIdReservations } from "../room/RoomIdReservations";
import { RoomPasswordGate } from "../room/RoomPasswordGate";
import { RoomTimers } from "../room/RoomTimers";
import type { SeatBindingContext } from "../room/SeatBinding";
import type { WhoIsFakerServiceOptions } from "./Options";
import { whoIsFakerShape } from "./RoomShape";
import { listRoomSummaries } from "./RoomViews";

/** 内核座位绑定用的上下文：绑定、转离线、解散都经它，对局记录与定时器随它进内核。 */
type WhoIsFakerSeatContext = SeatBindingContext<
  WhoIsFakerRoomRecord,
  WhoIsFakerPlayerRecord
> & {
  recorder: GameRecorder;
  timers: RoomTimers;
};

/**
 * 卧底上下文：只放数据与叶子工具（房间表、连接登记、时钟、随机源、发号器、口令与聊天限流、
 * 定时器与旁表、日志）。玩法行为是以它为第一个参数的自由函数；子模块拿上下文而不是整个服务门面，
 * 下层模块因此不会反向依赖上层。
 */
export interface WhoIsFakerContext {
  readonly options: WhoIsFakerServiceOptions;
  readonly rooms: Map<string, WhoIsFakerRoomRecord>;
  readonly connectionRegistry: ConnectionRegistry;
  readonly seatContext: WhoIsFakerSeatContext;
  readonly now: () => number;
  readonly random: RandomSource;
  /** 测试房策略：测试房特权一律问它，不再比较房号。 */
  readonly testRooms: TestRoomPolicy;
  /** 按房具名的定时器：阶段倒计时只有一个名字，同房重挂先清，关房清本房全部。 */
  readonly timers: RoomTimers;
  /** 号的形状只认本玩法自己发的前缀：快照恢复后据此把计数器抬过已用过的最大序号。 */
  readonly ids: IdCounter;
  /** 建房期间的房号占用：半成品房间不进房间表，读房间表的路径看不到它。 */
  readonly reservations: RoomIdReservations;
  /** 私密房口令：规范化、摘要与入房校验（含两层尝试限流）。 */
  readonly passwords: RoomPasswordGate;
  /** 每条聊天都会广播全房快照：每连接的聊天额度。 */
  readonly chatLimiter: ChatLimiter;
  /** 大厅列表的唯一出口：合并窗内的多次变更并为一次全量下发，订阅者单独取当前列表。 */
  readonly lobbyFanout: LobbyFanout;
  readonly publishedPhaseKeyByRoomId: Map<string, string>;
  readonly gameOverAdvanceAllowedAtByRoomId: Map<string, number>;
  /** 对局记录用的开局时间，按回合 ID 索引；结算或删房时移除。 */
  readonly roundStartedAtById: Map<string, number>;
  touch(room: WhoIsFakerRoomRecord): void;
  log(entry: LogEntry): Promise<void>;
  createId(prefix: string): string;
  appendSystemMessage(room: WhoIsFakerRoomRecord, text: string): void;
  createPlayer(
    name: string,
    isBot: boolean,
    isAgent?: boolean,
    seatId?: string
  ): WhoIsFakerPlayerRecord;
}

export const createWhoIsFakerContext = (options: WhoIsFakerServiceOptions): WhoIsFakerContext => {
  const now = options.now ?? (() => Date.now());
  const connectionRegistry = new ConnectionRegistry();
  const timers = new RoomTimers({
    onError: (roomId, name, error) =>
      options.eventLogger.error("房间定时器回调失败", {
        roomId,
        timer: name,
        ...describeError(error),
      }),
    setTimer: options.setTimer,
  });
  const missingPassword = { code: "PASSWORD_REQUIRED", message: "该操作需要有效密码" };
  const ctx: WhoIsFakerContext = {
    options,
    rooms: new Map(),
    connectionRegistry,
    seatContext: {
      shape: whoIsFakerShape,
      connections: connectionRegistry,
      now,
      recorder: options.gameRecorder ?? NOOP_GAME_RECORDER,
      timers,
    },
    now,
    random:
      options.random ??
      ({
        nextInt: (maxExclusive: number) => Math.floor(Math.random() * Math.max(maxExclusive, 1)),
      } satisfies RandomSource),
    testRooms: options.testRooms ?? TEST_ROOMS_DISABLED,
    timers,
    ids: new IdCounter(/^(?:round|description|chat|player|session)_([0-9a-z]+)$/),
    reservations: new RoomIdReservations({
      takenError: { code: "ROOM_ALREADY_EXISTS", message: "房间已存在" },
    }),
    passwords: new RoomPasswordGate({
      now,
      normalize: normalizeWord,
      missingOnCreate: missingPassword,
      missingOnJoin: missingPassword,
      hasher: options.passwordHasher,
    }),
    chatLimiter: new ChatLimiter({ now }),
    lobbyFanout: new LobbyFanout({
      event: WHOISFAKER_LOBBY_ROOMS_EVENT,
      now,
      broadcast: (payload) => connectionRegistry.broadcastToLobby(payload),
      summaries: () => listRoomSummaries(ctx),
      schedule: options.lobbyFanoutSchedule,
    }),
    publishedPhaseKeyByRoomId: new Map(),
    gameOverAdvanceAllowedAtByRoomId: new Map(),
    roundStartedAtById: new Map(),
    touch: (room) => {
      room.updatedAt = now();
      room.lastActivityAt = now();
    },
    log: async (entry) => {
      await options.eventLogger.write(entry);
    },
    createId: (prefix) => ctx.ids.next(prefix),
    appendSystemMessage: (room, text) => {
      appendChat(
        room,
        systemMessage({ id: ctx.createId("chat"), text, createdAt: now(), channel: "main" })
      );
    },
    createPlayer: (name, isBot, isAgent = false, seatId) => {
      const normalized = normalizeName(name);

      if (!normalized) {
        throw new AppError("INVALID_NAME", "用户名不能为空");
      }

      return {
        id: seatId ?? ctx.createId("player"),
        sessionToken: `${ctx.createId("session")}_${crypto.randomUUID()}`,
        name: normalized,
        score: 0,
        membership: "active",
        isReady: false,
        isBot,
        ...(isAgent ? { isAgent: true } : {}),
        online: !isBot,
        joinedAt: now(),
        lastSeenAt: now(),
      };
    },
  };
  return ctx;
};
