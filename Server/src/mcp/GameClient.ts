import { applyPatch } from "fast-json-patch";
import type { AgentFocusInput } from "../shared/AgentActivity";
import { isRecord } from "../shared/Json";
import { SeatUi } from "./ui/SeatUi";

export type GameId = "faker" | "song" | "cee";

export const GAME_IDS: readonly GameId[] = ["faker", "song", "cee"];

const GAME_META: Record<
  GameId,
  {
    path: string;
    lobby: string;
    lobbyCommand: string;
    snapshot: string;
    privateState: string;
    requestSync: string;
    reconnect: string;
    create: string;
    join: string;
    leave: string;
  }
> = {
  faker: {
    path: "/api/whoisfaker/ws",
    lobby: "lobby.rooms",
    lobbyCommand: "lobby.subscribeRooms",
    snapshot: "room.snapshot",
    privateState: "game.privateState",
    requestSync: "room.requestSync",
    reconnect: "room.reconnect",
    create: "room.create",
    join: "room.join",
    leave: "room.leave",
  },
  song: {
    path: "/api/songuessr/ws",
    lobby: "song.lobby.rooms",
    lobbyCommand: "song.lobby.subscribeRooms",
    snapshot: "song.room.snapshot",
    privateState: "song.game.privateState",
    requestSync: "song.room.requestSync",
    reconnect: "song.room.reconnect",
    create: "song.room.create",
    join: "song.room.join",
    leave: "song.room.leave",
  },
  cee: {
    path: "/api/cee/ws",
    lobby: "cee.lobby.rooms",
    lobbyCommand: "cee.lobby.subscribeRooms",
    snapshot: "cee.room.snapshot",
    privateState: "cee.game.privateState",
    requestSync: "cee.room.requestSync",
    reconnect: "cee.room.reconnect",
    create: "cee.room.create",
    join: "cee.room.join",
    leave: "cee.room.leave",
  },
};

const CONNECT_TIMEOUT_MS = 6_000;
/** 普通命令 20s；出题/开局/下一轮这类上游装配是长任务，由调用方显式放宽。 */
const COMMAND_TIMEOUT_MS = 20_000;
const LONG_COMMAND_TIMEOUT_MS = 180_000;
const EVENT_TIMEOUT_MS = 8_000;

interface PendingCommand {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface EventWaiter {
  resolve: (payload: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface GameSession {
  ws: WebSocket;
  ready: Promise<void>;
  pending: Map<string, PendingCommand>;
  waiters: Map<string, EventWaiter[]>;
  rooms: unknown[];
  snapshot?: Record<string, unknown>;
  privateState?: Record<string, unknown>;
  roomId?: string;
  playerId?: string;
  sessionToken?: string;
  closedReason?: string;
  /** 每次公开/私有状态到达都会递增；UI 操作后据此等待页面刷新。 */
  stateVersion: number;
  versionWaiters: Array<{
    since: number;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

/** 跨 WebSocket 断线保留的座位凭据；重连时用它接回原位。 */
interface SeatRecord {
  roomId: string;
  playerId?: string;
  sessionToken?: string;
}

export interface AgentGameClientOptions {
  serverUrl?: string;
  agentName: string;
  /** 测试里关掉人类速度节拍；线上保持默认。 */
  uiPacing?: boolean;
}

/** 聊天窗口在客户端与服务端都限制在 200 条；Agent 侧只保留同样上限。 */
const CHAT_LIMIT = 200;

/** 把状态同步帧（full / patch）应用成最新公开快照；不认识的形状原样保留。 */
export const applyStateSync = (
  current: Record<string, unknown> | undefined,
  payload: unknown
): Record<string, unknown> | undefined => {
  if (!isRecord(payload)) return current;
  if (payload.mode === "full" && isRecord(payload.state)) return payload.state;
  if (payload.mode === "patch" && Array.isArray(payload.operations) && current) {
    try {
      return applyPatch(
        structuredClone(current),
        payload.operations as Parameters<typeof applyPatch>[1],
        false,
        false,
        true
      ).newDocument;
    } catch {
      return current;
    }
  }
  // 少数事件直接发原始快照（没有状态同步包装）。
  return "roomId" in payload ? payload : current;
};

const mergeChat = (current: unknown, incoming: unknown): unknown[] => {
  const list = Array.isArray(current) ? current : [];
  const message = isRecord(incoming) ? incoming : undefined;
  if (!message || typeof message.id !== "string") return list;
  const existing = list.findIndex((entry) => isRecord(entry) && entry.id === message.id);
  if (existing >= 0) {
    const next = [...list];
    next[existing] = message;
    return next;
  }
  return [...list, message].slice(-CHAT_LIMIT);
};

/**
 * MCP 的游戏客户端：以普通玩家身份连接现有 WebSocket 协议，不嵌入三款游戏的服务端逻辑。
 * 只保存公开快照与本人座位的私有帧；其他座位的私有事件服务端根本不会发到这里。
 */
export class AgentGameClient {
  private readonly serverUrl: string;
  private readonly agentName: string;
  private readonly sessions = new Map<GameId, GameSession>();
  private readonly seats = new Map<GameId, SeatRecord>();
  /** 与人类页面同构的“屏幕”与控件操作层。 */
  readonly ui: SeatUi;

  constructor(options: AgentGameClientOptions) {
    this.serverUrl = (options.serverUrl ?? "http://127.0.0.1:4850").replace(/\/+$/, "");
    this.agentName = options.agentName;
    this.ui = new SeatUi(this, { pacing: options.uiPacing !== false });
  }

  get name(): string {
    return this.agentName;
  }

  currentRoom(game: GameId): string | undefined {
    return this.sessions.get(game)?.roomId;
  }

  currentPlayerId(game: GameId): string | undefined {
    return this.sessions.get(game)?.playerId;
  }

  currentSnapshot(game: GameId): Record<string, unknown> | undefined {
    return this.sessions.get(game)?.snapshot;
  }

  /** 只返回服务端已经发给这一位玩家的私有状态；绝不含其他座位的私有帧。 */
  currentPrivateState(game: GameId): Record<string, unknown> | undefined {
    return this.sessions.get(game)?.privateState;
  }

  /** 列房间：先订阅大厅，拿到该游戏的最新一帧房间列表。 */
  async listRooms(game: GameId): Promise<unknown[]> {
    const session = await this.connect(game);
    const waiting = this.waitForEvent(session, GAME_META[game].lobby);
    await this.command(session, GAME_META[game].lobbyCommand, {});
    await waiting;
    return session.rooms;
  }

  async join(
    game: GameId,
    roomId: string,
    options: { name?: string; password?: string } = {}
  ): Promise<{
    game: GameId;
    roomId: string;
    playerId?: string;
    snapshot?: Record<string, unknown>;
  }> {
    const session = await this.connect(game);
    if (session.roomId === roomId) {
      return { game, roomId, playerId: session.playerId, snapshot: session.snapshot };
    }
    if (session.roomId) await this.leave(game);

    const payload: Record<string, unknown> = { userName: options.name ?? this.agentName };
    if (options.password) payload.password = options.password;
    return this.enter(game, session, GAME_META[game].join, roomId, payload);
  }

  /**
   * 认领人类玩家在 MCP 设置里复制的会话凭证：MCP 连接接手该座位，
   * 服务端随后只允许这个 Agent 连接执行该座位的操作。
   */
  async claimSeat(
    game: GameId,
    roomId: string,
    sessionToken: string
  ): Promise<{
    game: GameId;
    roomId: string;
    playerId?: string;
    snapshot?: Record<string, unknown>;
  }> {
    const session = await this.connect(game);
    if (session.roomId) await this.leave(game);
    const ack = (await this.command(
      session,
      "mcp.claim",
      { roomId, sessionToken },
      { timeoutMs: COMMAND_TIMEOUT_MS }
    )) as Record<string, unknown> | undefined;
    if (!ack || typeof ack.roomId !== "string") throw new Error("认领座位没有返回房间凭据");
    session.roomId = ack.roomId;
    session.playerId = typeof ack.playerId === "string" ? ack.playerId : undefined;
    session.sessionToken = typeof ack.sessionToken === "string" ? ack.sessionToken : undefined;
    session.snapshot = isRecord(ack.snapshot) ? ack.snapshot : undefined;
    session.privateState = isRecord(ack.privateState) ? ack.privateState : undefined;
    this.seats.set(game, {
      roomId: session.roomId,
      playerId: session.playerId,
      sessionToken: session.sessionToken,
    });
    return {
      game,
      roomId: session.roomId,
      playerId: session.playerId,
      snapshot: session.snapshot,
    };
  }

  async create(
    game: GameId,
    roomId: string,
    options: {
      name: string;
      userName: string;
      visibility: "public" | "private";
      allowSpectators: boolean;
      allowAgents: boolean;
      password?: string;
      solo?: boolean;
      roleConfig?: Record<string, unknown>;
    }
  ): Promise<{
    game: GameId;
    roomId: string;
    playerId?: string;
    snapshot?: Record<string, unknown>;
  }> {
    const session = await this.connect(game);
    if (session.roomId) await this.leave(game);
    const payload: Record<string, unknown> = {
      roomId,
      name: options.name,
      visibility: options.visibility,
      allowSpectators: options.allowSpectators,
      userName: options.userName,
      allowAgents: options.allowAgents,
      ...(options.password ? { password: options.password } : {}),
      ...(game === "song" && options.solo ? { solo: true } : {}),
      ...(game === "faker" && options.roleConfig ? { roleConfig: options.roleConfig } : {}),
    };
    if (game === "cee") payload.source = "native";
    return this.enter(game, session, GAME_META[game].create, roomId, payload);
  }

  private async enter(
    game: GameId,
    session: GameSession,
    type: string,
    roomId: string,
    payload: Record<string, unknown>
  ): Promise<{
    game: GameId;
    roomId: string;
    playerId?: string;
    snapshot?: Record<string, unknown>;
  }> {
    const waiting = this.waitForEvent(session, GAME_META[game].snapshot);
    const ack = (await this.command(session, type, payload, {
      roomId,
      timeoutMs: LONG_COMMAND_TIMEOUT_MS,
    })) as Record<string, unknown> | undefined;
    if (!ack) throw new Error("进入房间没有返回会话凭据");

    session.roomId = typeof ack.roomId === "string" ? ack.roomId : roomId;
    session.sessionToken = typeof ack.sessionToken === "string" ? ack.sessionToken : undefined;
    const privateState = isRecord(ack.privateState) ? ack.privateState : undefined;
    session.privateState = privateState;
    session.playerId =
      typeof ack.playerId === "string"
        ? ack.playerId
        : typeof privateState?.playerId === "string"
          ? privateState.playerId
          : undefined;
    if (isRecord(ack.snapshot)) session.snapshot = ack.snapshot;
    this.seats.set(game, {
      roomId: session.roomId,
      playerId: session.playerId,
      sessionToken: session.sessionToken,
    });

    // Faker 的进房回执只带凭据，公开快照随后作为事件到达；等一帧，等不到也保留已加入状态。
    if (!session.snapshot) await waiting;
    return {
      game,
      roomId: session.roomId,
      playerId: session.playerId,
      snapshot: session.snapshot,
    };
  }

  async leave(game: GameId): Promise<boolean> {
    const session = this.sessions.get(game);
    if (!session?.roomId) return false;
    await this.command(session, GAME_META[game].leave, {});
    session.roomId = undefined;
    session.playerId = undefined;
    session.sessionToken = undefined;
    session.snapshot = undefined;
    session.privateState = undefined;
    this.seats.delete(game);
    return true;
  }

  /** 发送游戏命令；roomId 与 sessionToken 由当前会话自动补齐。 */
  private command(
    session: GameSession,
    type: string,
    payload: Record<string, unknown>,
    options: { roomId?: string; sessionToken?: string; timeoutMs?: number } = {}
  ): Promise<unknown> {
    const id = crypto.randomUUID();
    const message: Record<string, unknown> = { id, type, payload };
    const roomId = options.roomId ?? session.roomId;
    const sessionToken = options.sessionToken ?? session.sessionToken;
    if (roomId) message.roomId = roomId;
    if (sessionToken) message.sessionToken = sessionToken;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`游戏命令超时：${type}`));
      }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
      session.pending.set(id, { resolve, reject, timer });
      try {
        session.ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async sendInRoom(
    game: GameId,
    type: string,
    payload: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    const session = await this.connect(game);
    if (!session.roomId) throw new Error("尚未加入该游戏的房间");
    return this.command(session, type, payload, options);
  }

  /** 当前页面状态版本；UI 操作前后对比它来确认人类页面已经刷新。 */
  stateVersion(game: GameId): number {
    return this.sessions.get(game)?.stateVersion ?? 0;
  }

  /** 等到状态版本超过 `since`；超时不报错，UI 仍会返回当前屏幕。 */
  async waitForStateChange(game: GameId, since: number, timeoutMs = 1_800): Promise<boolean> {
    const session = this.sessions.get(game);
    if (!session) return false;
    if (session.stateVersion > since) return true;
    return new Promise((resolve) => {
      const waiter = {
        since,
        resolve: () => {
          clearTimeout(waiter.timer);
          resolve(true);
        },
        timer: setTimeout(() => {
          session.versionWaiters = session.versionWaiters.filter((entry) => entry !== waiter);
          resolve(session.stateVersion > since);
        }, timeoutMs),
      };
      session.versionWaiters.push(waiter);
    });
  }

  private bumpState(session: GameSession): void {
    session.stateVersion += 1;
    const waiters = [...session.versionWaiters];
    session.versionWaiters = [];
    for (const waiter of waiters) {
      if (session.stateVersion > waiter.since) waiter.resolve();
      else session.versionWaiters.push(waiter);
    }
  }

  /**
   * 上报「正在操作哪类界面」。只携带界面焦点，不携带答案、词语或搜索词；
   * 失败不阻断工具本身，人类页面最多少一次提示。
   */
  async publishAgentFocus(input: AgentFocusInput, game?: GameId): Promise<void> {
    const targets = game
      ? ([[game, this.sessions.get(game)]] as const)
      : [...this.sessions.entries()];
    await Promise.all(
      targets.map(async ([, session]) => {
        if (!session || session.ws.readyState !== WebSocket.OPEN) return;
        try {
          await this.command(
            session,
            "mcp.focus",
            { ...input },
            {
              roomId: session.roomId,
              timeoutMs: 3_000,
            }
          );
        } catch {
          /* 活动提示是增强信息，失败不影响工具结果 */
        }
      })
    );
  }

  /** 主动同步：服务端会重发当前快照与本人私有状态。 */
  async requestSync(game: GameId): Promise<unknown> {
    const session = await this.connect(game);
    if (!session.roomId) throw new Error("尚未加入该游戏的房间");
    const privateEvent = GAME_META[game].privateState;
    const privateWaiting = this.waitForEvent(session, privateEvent, 3_000);
    const result = await this.command(session, GAME_META[game].requestSync, {});
    await privateWaiting;
    return result;
  }

  /** 关闭所有连接；MCP 进程退出前调用。 */
  close(): void {
    for (const session of this.sessions.values()) {
      try {
        session.ws.close();
      } catch {
        /* 已经关闭 */
      }
    }
    this.sessions.clear();
  }

  private gamePath(game: GameId): string {
    const base = new URL(this.serverUrl);
    const target = new URL(GAME_META[game].path, base);
    target.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    target.searchParams.set("agent", "1");
    return target.toString();
  }

  private connect(game: GameId): Promise<GameSession> {
    const existing = this.sessions.get(game);
    if (existing && existing.ws.readyState === WebSocket.OPEN) return Promise.resolve(existing);
    if (existing) this.sessions.delete(game);

    const ws = new WebSocket(this.gamePath(game));
    const session: GameSession = {
      ws,
      ready: Promise.resolve(),
      pending: new Map(),
      waiters: new Map(),
      rooms: [],
      stateVersion: 0,
      versionWaiters: [],
    };
    this.sessions.set(game, session);

    session.ready = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* 忽略 */
        }
        reject(new Error("连接游戏服务超时，请确认 MCP_ENABLED 已开启"));
      }, CONNECT_TIMEOUT_MS);
      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("无法连接游戏服务；请确认服务端 MCP_ENABLED=true"));
      });
      ws.addEventListener("close", (event) => {
        clearTimeout(timer);
        session.closedReason = event.reason || "连接已关闭（Agent 接入未启用，或连接被服务端拒绝）";
        this.failPending(session, new Error(session.closedReason));
        if (!settled) {
          settled = true;
          reject(new Error(session.closedReason));
        }
      });
      ws.addEventListener("message", (event) => {
        void this.handleMessage(session, event.data);
      });
    });
    return session.ready.then(async () => {
      await this.restoreSeat(game, session);
      return session;
    });
  }

  /**
   * WebSocket 断开后靠座位凭据接回原位。
   * 只有明确判定凭据失效/房间不存在时才丢弃座位，网络抖动留给下一次工具调用重试。
   */
  private async restoreSeat(game: GameId, session: GameSession): Promise<void> {
    const seat = this.seats.get(game);
    if (!seat?.sessionToken) return;
    try {
      const ack = (await this.command(
        session,
        GAME_META[game].reconnect,
        {
          roomId: seat.roomId,
          sessionToken: seat.sessionToken,
        },
        { roomId: seat.roomId, sessionToken: seat.sessionToken }
      )) as Record<string, unknown> | undefined;
      if (!isRecord(ack)) return;
      session.roomId = typeof ack.roomId === "string" ? ack.roomId : seat.roomId;
      session.sessionToken =
        typeof ack.sessionToken === "string" ? ack.sessionToken : seat.sessionToken;
      const privateState = isRecord(ack.privateState) ? ack.privateState : undefined;
      session.privateState = privateState;
      session.playerId =
        typeof ack.playerId === "string"
          ? ack.playerId
          : typeof privateState?.playerId === "string"
            ? privateState.playerId
            : seat.playerId;
      if (isRecord(ack.snapshot)) session.snapshot = ack.snapshot;
      this.seats.set(game, {
        roomId: session.roomId,
        playerId: session.playerId,
        sessionToken: session.sessionToken,
      });
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (
        code === "SESSION_INVALID" ||
        code === "SESSION_EXPIRED" ||
        code === "ROOM_NOT_FOUND" ||
        code === "ROOM_CLOSED"
      ) {
        this.seats.delete(game);
      }
      throw error;
    }
  }

  private async handleMessage(session: GameSession, raw: unknown): Promise<void> {
    const text =
      typeof raw === "string"
        ? raw
        : raw instanceof ArrayBuffer
          ? new TextDecoder().decode(raw)
          : await new Response(raw as Blob).text();
    let packet: unknown;
    try {
      packet = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(packet)) return;
    if (packet.type === "ack" && typeof packet.id === "string") {
      this.settleCommand(session, packet.id, packet.payload);
      return;
    }
    if (packet.type === "error" && typeof packet.id === "string") {
      this.rejectCommand(session, packet.id, packet.error);
      return;
    }
    if (packet.type !== "event" || typeof packet.event !== "string") return;

    const game = [...this.sessions.entries()].find(([, value]) => value === session)?.[0];
    if (!game) return;
    this.applySessionEvent(session, game, packet.event, packet.payload);
    this.resolveWaiters(session, packet.event, packet.payload);
  }

  private settleCommand(session: GameSession, id: string, payload: unknown): void {
    const pending = session.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    session.pending.delete(id);
    pending.resolve(payload);
  }

  private rejectCommand(session: GameSession, id: string, value: unknown): void {
    const pending = session.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    session.pending.delete(id);
    const error = isRecord(value) ? value : {};
    const message = typeof error.message === "string" ? error.message : "游戏服务拒绝了命令";
    pending.reject(
      Object.assign(new Error(message), {
        code: typeof error.code === "string" ? error.code : undefined,
      })
    );
  }

  private applySessionEvent(
    session: GameSession,
    game: GameId,
    event: string,
    payload: unknown
  ): void {
    const meta = GAME_META[game];
    if (event === meta.lobby) {
      session.rooms = Array.isArray(payload) ? payload : [];
      this.bumpState(session);
      return;
    }
    if (event === meta.snapshot) {
      session.snapshot = applyStateSync(session.snapshot, payload);
      this.bumpState(session);
      return;
    }
    if (event === meta.privateState) {
      session.privateState = applyStateSync(session.privateState, payload);
      this.bumpState(session);
      return;
    }
    if (!session.snapshot) {
      this.clearClosedSession(session, event);
      return;
    }
    if (event === "song.chat.message" && isRecord(payload)) {
      session.snapshot = {
        ...session.snapshot,
        chat: mergeChat(session.snapshot.chat, payload.message),
      };
      this.bumpState(session);
    } else {
      this.clearClosedSession(session, event);
    }
  }

  private clearClosedSession(session: GameSession, event: string): void {
    if (!event.endsWith("room.closed")) return;
    session.roomId = undefined;
    session.playerId = undefined;
    session.sessionToken = undefined;
    session.snapshot = undefined;
    session.privateState = undefined;
    this.bumpState(session);
    const game = [...this.sessions.entries()].find(([, value]) => value === session)?.[0];
    if (game) this.seats.delete(game);
  }

  private resolveWaiters(session: GameSession, event: string, payload: unknown): void {
    const waiters = session.waiters.get(event);
    if (!waiters) return;
    session.waiters.delete(event);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
    }
  }

  private waitForEvent(
    session: GameSession,
    event: string,
    timeoutMs = EVENT_TIMEOUT_MS
  ): Promise<unknown> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = session.waiters.get(event);
        if (waiters) {
          const remaining = waiters.filter((entry) => entry.resolve !== resolve);
          if (remaining.length) session.waiters.set(event, remaining);
          else session.waiters.delete(event);
        }
        resolve(undefined);
      }, timeoutMs);
      const waiter: EventWaiter = { resolve, timer };
      const waiters = session.waiters.get(event) ?? [];
      waiters.push(waiter);
      session.waiters.set(event, waiters);
    });
  }

  private failPending(session: GameSession, error: Error): void {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
  }
}
