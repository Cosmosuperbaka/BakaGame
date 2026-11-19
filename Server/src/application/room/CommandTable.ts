import { AppError, unsupportedCommand } from "../../domain/Errors";
import { SlidingWindowRateLimiter } from "../../infrastructure/RateLimiter";
import type { ConnectionRecord } from "../../shared/Model";

/**
 * 命令表：每条命令声明准入（`access`）、阶段（`phases`，必填，逼每条命令对阶段表态）与玩法守卫，
 * 分发器先解析席位、再跑声明的守卫、最后执行。表用映射类型保证穷尽：协议里每个命令类型都必须
 * 有一条，漏一条就编译失败。
 *
 * 跨 await 的命令在 await 之后调用 `at.recheck()`，把同一组声明（外加「房间仍在登记、座位仍在名册」）
 * 重跑一遍。await 之后的复核以前靠手抄，抄漏一项就是一次越权或半截写入。
 * 命令成功后的发布不归这里：三款的发布时机与次数各有讲究，统一会改变下行帧的顺序。
 */

export type CommandResult = Record<string, unknown> | void;

export interface PhaseRule<TPhase extends string> {
  readonly allow: readonly TPhase[];
  readonly code: string;
  readonly message: string;
}

export interface CommandAt<TRoom, TSeat> {
  readonly connection: ConnectionRecord;
  readonly room: TRoom;
  readonly seat: TSeat;
}

/** 玩法自定的额外守卫：不成立就抛业务错误。必须是无副作用的纯判定，复核时会再跑一遍。 */
export type Guard<TRoom, TSeat> = (at: CommandAt<TRoom, TSeat>) => void;

export interface CommandSeat<TRoom, TSeat> extends CommandAt<TRoom, TSeat> {
  /** await 之后调用：房间仍在登记、座位仍在名册，并重跑本命令声明的 access、phases、guards。 */
  recheck(): void;
}

type Awaitable<T> = T | Promise<T>;

export interface LobbyCommand<TMessage, TDeps> {
  readonly access: "lobby";
  run(deps: TDeps, connection: ConnectionRecord, message: TMessage): Awaitable<CommandResult>;
}

export interface SeatedCommand<TMessage, TDeps, TRoom, TSeat, TPhase extends string> {
  /** `seat`：已入座的成员；`host`：房主。 */
  readonly access: "seat" | "host";
  readonly phases: "any" | PhaseRule<TPhase>;
  readonly guards?: readonly Guard<TRoom, TSeat>[];
  run(deps: TDeps, at: CommandSeat<TRoom, TSeat>, message: TMessage): Awaitable<CommandResult>;
}

export type CommandSpec<TMessage, TDeps, TRoom, TSeat, TPhase extends string> =
  LobbyCommand<TMessage, TDeps> | SeatedCommand<TMessage, TDeps, TRoom, TSeat, TPhase>;

export type CommandTable<
  TMessage extends { type: string },
  TDeps,
  TRoom,
  TSeat,
  TPhase extends string,
> = {
  readonly [K in TMessage["type"]]: CommandSpec<
    Extract<TMessage, { type: K }>,
    TDeps,
    TRoom,
    TSeat,
    TPhase
  >;
};

export interface CommandDispatcher<
  TMessage extends { type: string },
  TDeps,
  TRoom,
  TSeat extends { id: string },
  TPhase extends string,
> {
  readonly table: CommandTable<TMessage, TDeps, TRoom, TSeat, TPhase>;
  readonly deps: TDeps;
  /**
   * 局内命令的身份确认：卧底与猜歌认连接上绑定的席位，CEE 逐条核令牌。
   * 找不到时由玩法抛自己的错误码。
   */
  resolveSeat(connection: ConnectionRecord, message: TMessage): { room: TRoom; seat: TSeat };
  /** 房间仍是登记中的那一份（不是已关闭后同号重建的另一间）。 */
  isRoomRegistered(room: TRoom): boolean;
  /** 座位仍在名册且未被移出。 */
  isSeated(room: TRoom, seat: TSeat): boolean;
  hostIdOf(room: TRoom): string;
  phaseOf(room: TRoom): TPhase;
}

const admit = <
  TMessage extends { type: string },
  TDeps,
  TRoom,
  TSeat extends { id: string },
  TPhase extends string,
>(
  dispatcher: CommandDispatcher<TMessage, TDeps, TRoom, TSeat, TPhase>,
  spec: SeatedCommand<TMessage, TDeps, TRoom, TSeat, TPhase>,
  at: CommandAt<TRoom, TSeat>
): void => {
  if (!dispatcher.isRoomRegistered(at.room))
    throw new AppError("ROOM_NOT_FOUND", "房间不存在或已关闭");
  if (!dispatcher.isSeated(at.room, at.seat))
    throw new AppError("PLAYER_NOT_FOUND", "房间内不存在当前玩家");
  if (spec.access === "host" && dispatcher.hostIdOf(at.room) !== at.seat.id)
    throw new AppError("FORBIDDEN", "只有房主可以执行该操作");
  const phases = spec.phases;
  if (phases !== "any" && !phases.allow.includes(dispatcher.phaseOf(at.room)))
    throw new AppError(phases.code, phases.message);
  for (const guard of spec.guards ?? []) guard(at);
};

export const dispatchCommand = async <
  TMessage extends { type: string },
  TDeps,
  TRoom,
  TSeat extends { id: string },
  TPhase extends string,
>(
  dispatcher: CommandDispatcher<TMessage, TDeps, TRoom, TSeat, TPhase>,
  connection: ConnectionRecord,
  message: TMessage
): Promise<CommandResult> => {
  // 映射类型按命令类型逐条收窄，按运行时的 type 取出来时 TS 只能给出并集；
  // 表的键与 message.type 来自同一份协议类型，这里放宽到整条消息的口径是等价的。
  const table = dispatcher.table as Record<
    string,
    CommandSpec<TMessage, TDeps, TRoom, TSeat, TPhase>
  >;
  // 只认表自己的键：`constructor`、`toString` 这类名字在原型上取得到东西，不能被当成命令。
  const spec = Object.hasOwn(table, message.type) ? table[message.type] : undefined;
  if (!spec) return unsupportedCommand();
  if (spec.access === "lobby") return spec.run(dispatcher.deps, connection, message);
  const { room, seat } = dispatcher.resolveSeat(connection, message);
  const at: CommandSeat<TRoom, TSeat> = {
    connection,
    room,
    seat,
    recheck: () => admit(dispatcher, spec, at),
  };
  at.recheck();
  return spec.run(dispatcher.deps, at, message);
};

/**
 * 每连接的命令总额度：任何命令都先扣它，按成本另计的配额在它之后。
 * 由各玩法在自己的命令入口、预检与分发之前调用：预检（如敏感词扫描）排在分发外层，
 * 额度放进分发器里就会让高频命令先白做一遍预检再被限流。
 */
export class CommandQuota {
  private readonly limiter: SlidingWindowRateLimiter;

  constructor(
    private readonly options: { now: () => number; windowMs: number; maxRequests: number }
  ) {
    this.limiter = new SlidingWindowRateLimiter({
      windowMs: options.windowMs,
      maxRequests: options.maxRequests,
    });
  }

  consume(connection: ConnectionRecord): void {
    if (!this.limiter.allow(connection.id, this.options.now()))
      throw new AppError("RATE_LIMITED", "操作过于频繁，请稍后再试");
  }
}
