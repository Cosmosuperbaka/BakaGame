import { applyPatch } from "fast-json-patch";

export type GameId = "faker" | "song" | "cee";

export const GAME_IDS: readonly GameId[] = ["faker", "song", "cee"];

const GAME_META: Record<
  GameId,
  { path: string; lobby: string; lobbyCommand: string; snapshot: string; create: string; join: string; leave: string }
> = {
  faker: {
    path: "/api/whoisfaker/ws",
    lobby: "lobby.rooms",
    lobbyCommand: "lobby.subscribeRooms",
    snapshot: "room.snapshot",
    create: "room.create",
    join: "room.join",
    leave: "room.leave",
  },
  song: {
    path: "/api/songuessr/ws",
    lobby: "song.lobby.rooms",
    lobbyCommand: "song.lobby.subscribeRooms",
    snapshot: "song.room.snapshot",
    create: "song.room.create",
    join: "song.room.join",
    leave: "song.room.leave",
  },
  cee: {
    path: "/api/cee/ws",
    lobby: "cee.lobby.rooms",
    lobbyCommand: "cee.lobby.subscribeRooms",
    snapshot: "cee.room.snapshot",
    create: "cee.room.create",
    join: "cee.room.join",
    leave: "cee.room.leave",
  },
};

const CONNECT_TIMEOUT_MS = 6_000;
const COMMAND_TIMEOUT_MS = 10_000;
const EVENT_TIMEOUT_MS = 4_000;

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
  roomId?: string;
  playerId?: string;
  sessionToken?: string;
  closedReason?: string;
}

export interface AgentGameClientOptions {
  serverUrl?: string;
  agentName: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

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
  const existing = list.findIndex(
    (entry) => isRecord(entry) && entry.id === message.id
  );
  if (existing >= 0) {
    const next = [...list];
    next[existing] = message;
    return next;
  }
  return [...list, message].slice(-CHAT_LIMIT);
};

const applyChatPlusOne = (current: unknown, payload: unknown): unknown[] => {
  const list = Array.isArray(current) ? current : [];
  if (!isRecord(payload) || typeof payload.messageId !== "string") return list;
  if (!Array.isArray(payload.plusOneBy)) return list;
  const plusOneBy = payload.plusOneBy.filter((id): id is string => typeof id === "string");
  return list.map((entry) =>
    isRecord(entry) && entry.id === payload.messageId ? { ...entry, plusOneBy } : entry
  );
};

/**
 * MCP 的游戏客户端：以普通玩家身份连接现有 WebSocket 协议，不嵌入三款游戏的服务端逻辑。
 * 只保存公开快照，私有状态事件一律丢弃，避免 Agent 拿到答案类字段。
 */
export class AgentGameClient {
  private readonly serverUrl: string;
  private readonly agentName: string;
  private readonly sessions = new Map<GameId, GameSession>();

  constructor(options: AgentGameClientOptions) {
    this.serverUrl = (options.serverUrl ?? "http://127.0.0.1:4850").replace(/\/+$/, "");
    this.agentName = options.agentName;
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
      name: options.name,
      visibility: options.visibility,
      allowSpectators: options.allowSpectators,
      userName: options.userName,
      allowAgents: options.allowAgents,
      ...(options.password ? { password: options.password } : {}),
    };
    if (game === "cee") {
      payload.source = "native";
      payload.roomId = roomId;
    }
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
    const ack = (await this.command(session, type, payload, { roomId })) as
      | Record<string, unknown>
      | undefined;
    if (!ack) throw new Error("进入房间没有返回会话凭据");

    session.roomId = typeof ack.roomId === "string" ? ack.roomId : roomId;
    session.sessionToken = typeof ack.sessionToken === "string" ? ack.sessionToken : undefined;
    const privateState = isRecord(ack.privateState) ? ack.privateState : undefined;
    session.playerId =
      typeof ack.playerId === "string"
        ? ack.playerId
        : typeof privateState?.playerId === "string"
          ? privateState.playerId
          : undefined;
    if (isRecord(ack.snapshot)) session.snapshot = ack.snapshot;

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
    return true;
  }

  /** 发送游戏命令；roomId 与 sessionToken 由当前会话自动补齐。 */
  private command(
    session: GameSession,
    type: string,
    payload: Record<string, unknown>,
    options: { roomId?: string; sessionToken?: string } = {}
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
      }, COMMAND_TIMEOUT_MS);
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
    payload: Record<string, unknown> = {}
  ): Promise<unknown> {
    const session = this.sessions.get(game);
    if (!session?.roomId) throw new Error("尚未加入该游戏的房间");
    return this.command(session, type, payload);
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
        session.closedReason =
          event.reason || "连接已关闭（Agent 接入未启用，或连接被服务端拒绝）";
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
    return session.ready.then(() => session);
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
    const message =
      typeof error.message === "string" ? error.message : "游戏服务拒绝了命令";
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
      return;
    }
    if (event === meta.snapshot) {
      session.snapshot = applyStateSync(session.snapshot, payload);
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
    } else if (event === "song.chat.plusOne") {
      session.snapshot = {
        ...session.snapshot,
        chat: applyChatPlusOne(session.snapshot.chat, payload),
      };
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

  private waitForEvent(session: GameSession, event: string): Promise<unknown> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = session.waiters.get(event);
        if (waiters) {
          const remaining = waiters.filter((entry) => entry.resolve !== resolve);
          if (remaining.length) session.waiters.set(event, remaining);
          else session.waiters.delete(event);
        }
        resolve(undefined);
      }, EVENT_TIMEOUT_MS);
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
