import { applyPatch } from "fast-json-patch";
import type { AgentFocusInput, SiteFocusPayload } from "../shared/AgentActivity";
import { isRecord } from "../shared/Json";
import { mergeChatWindow, type ChatWindowEntry } from "../shared/ChatWindow";
import { isPermanentRoomError } from "../shared/Model";
import { GAME_IDS, type GameId } from "../shared/Protocol";
import { SeatUi } from "./ui/SeatUi";

export type { GameId };
export { GAME_IDS };

const GAME_META: Record<
  GameId,
  {
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

/** 统一入口：三款游戏与站点通道共用一条升级路径。 */
export const AGENT_WS_PATH = "/api/ws";

const CONNECT_TIMEOUT_MS = 6_000;
/** 普通命令 20s；出题/开局/下一轮这类上游装配是长任务，由调用方显式放宽。 */
const COMMAND_TIMEOUT_MS = 20_000;
const LONG_COMMAND_TIMEOUT_MS = 180_000;
const EVENT_TIMEOUT_MS = 8_000;
/** 站点焦点是广播用增强信息：超时与失败都不能拖慢工具本身的返回。 */
const SITE_FOCUS_TIMEOUT_MS = 3_000;

interface PendingCommand {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface EventWaiter {
  resolve: (payload: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 一款游戏在**共享连接**上的会话状态。
 *
 * 连接与请求表都不在这里：一条 `/api/ws` 连接同时承载三款游戏与站点通道，
 * 待回执的命令按 id 全局登记，事件按名字前缀归到各自的会话。
 */
interface GameSession {
  rooms: unknown[];
  snapshot?: Record<string, unknown>;
  privateState?: Record<string, unknown>;
  roomId?: string;
  playerId?: string;
  sessionToken?: string;
  /** 每次公开/私有状态到达都会递增；UI 操作后据此等待页面刷新。 */
  stateVersion: number;
  /** 生成号与 socket 实例对齐：换了一条连接就要重新接回座位。 */
  restoredGeneration: number;
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

type ChatRecord = ChatWindowEntry & Record<string, unknown>;
/** 快照与推送都是未校验的 JSON：只收有 id 与时间的条目，再按与玩家页面同一份窗口口径续接。 */
const chatRecords = (value: unknown): ChatRecord[] =>
  (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is ChatRecord =>
      isRecord(entry) && typeof entry.id === "string" && typeof entry.createdAt === "number"
  );
const mergeChat = (current: unknown, incoming: unknown): ChatRecord[] =>
  mergeChatWindow(chatRecords(current), chatRecords(incoming));

/** 事件名归属：歌与角色游戏的整张事件表都带前缀，卧底的反过来一条都不带。 */
export const gameOfEvent = (event: string): GameId => {
  if (event.startsWith("song.")) return "song";
  if (event.startsWith("cee.")) return "cee";
  return "faker";
};

/**
 * MCP 的游戏客户端：以普通玩家身份连接现有 WebSocket 协议，不嵌入三款游戏的服务端逻辑。
 *
 * **一条连接**同时承载三款游戏与站点活动上报（`/api/ws`）：Agent 在首页/大厅就能建立
 * 连接并读取三款游戏的大厅，不必先「进入」某款游戏。命令按信封上的 `game` 分发，
 * 事件按名字前缀归到各自的会话；待回执命令用全局 id 表登记。
 *
 * 只保存公开快照与本人座位的私有帧；其他座位的私有事件服务端根本不会发到这里。
 */
export class AgentGameClient {
  private readonly serverUrl: string;
  private readonly agentName: string;
  private readonly sessions = new Map<GameId, GameSession>();
  private readonly seats = new Map<GameId, SeatRecord>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly waiters = new Map<string, EventWaiter[]>();
  private socket: WebSocket | null = null;
  private socketReady: Promise<void> | null = null;
  /** 每建立一条新连接 +1，方便判断某款游戏是否需要重新接回座位。 */
  private socketGeneration = 0;
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

  /** 站点公开地址：与 API 同源（边缘反代），用于把人类可达页面拼成绝对链接。 */
  get siteOrigin(): string {
    return this.serverUrl;
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
    const waiting = this.waitForEvent(GAME_META[game].lobby);
    await this.command(game, GAME_META[game].lobbyCommand, {});
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
      game,
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
    const waiting = this.waitForEvent(GAME_META[game].snapshot);
    const ack = (await this.command(game, type, payload, {
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
    await this.command(game, GAME_META[game].leave, {});
    session.roomId = undefined;
    session.playerId = undefined;
    session.sessionToken = undefined;
    session.snapshot = undefined;
    session.privateState = undefined;
    this.seats.delete(game);
    return true;
  }

  /**
   * 发送命令；roomId 与 sessionToken 由该游戏的会话自动补齐。
   * `game` 缺省时只用于站点命令（`site.focus` / `site.leave`），信封上不带归属。
   */
  private command(
    game: GameId | undefined,
    type: string,
    payload: Record<string, unknown>,
    options: { roomId?: string; sessionToken?: string; timeoutMs?: number } = {}
  ): Promise<unknown> {
    const id = crypto.randomUUID();
    const message: Record<string, unknown> = { id, type, payload };
    const session = game ? this.sessions.get(game) : undefined;
    if (game) message.game = game;
    const roomId = options.roomId ?? session?.roomId;
    const sessionToken = options.sessionToken ?? session?.sessionToken;
    if (roomId) message.roomId = roomId;
    if (sessionToken) message.sessionToken = sessionToken;

    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error("与游戏服务的连接已断开"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`游戏命令超时：${type}`));
      }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
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
    return this.command(game, type, payload, options);
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
      targets.map(async ([target, session]) => {
        if (!session || this.socket?.readyState !== WebSocket.OPEN) return;
        try {
          await this.command(
            target,
            "mcp.focus",
            { ...input },
            {
              roomId: session.roomId,
              timeoutMs: SITE_FOCUS_TIMEOUT_MS,
            }
          );
        } catch {
          /* 活动提示是增强信息，失败不影响工具结果 */
        }
      })
    );
  }

  /**
   * 上报站点级活动：首页与大厅的访客据此看到 Agent「在哪个页面、做什么」。
   *
   * 这条通道**不要求已进房**——Agent 从首页开始就能被看见。字段封闭，逐字输入与
   * 控件焦点不进这里；失败同样不阻断工具。
   */
  async publishSiteFocus(input: SiteFocusPayload): Promise<void> {
    try {
      await this.ensureSocket();
      await this.command(
        undefined,
        "site.focus",
        { ...input },
        {
          timeoutMs: SITE_FOCUS_TIMEOUT_MS,
        }
      );
    } catch {
      /* 首页指示器是增强信息，连不上或超时都不影响工具结果 */
    }
  }

  /** 主动同步：服务端会重发当前快照与本人私有状态。 */
  async requestSync(game: GameId): Promise<unknown> {
    const session = await this.connect(game);
    if (!session.roomId) throw new Error("尚未加入该游戏的房间");
    const privateEvent = GAME_META[game].privateState;
    const privateWaiting = this.waitForEvent(privateEvent, 3_000);
    const result = await this.command(game, GAME_META[game].requestSync, {});
    await privateWaiting;
    return result;
  }

  /** 关闭连接；MCP 进程退出前调用。 */
  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.socketReady = null;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      /* 已经关闭 */
    }
  }

  private socketPath(): string {
    const base = new URL(this.serverUrl);
    const target = new URL(AGENT_WS_PATH, base);
    target.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    target.searchParams.set("agent", "1");
    return target.toString();
  }

  private createSession(): GameSession {
    return {
      rooms: [],
      stateVersion: 0,
      restoredGeneration: 0,
      versionWaiters: [],
    };
  }

  /**
   * 一条物理连接承载全部游戏。首次调用建立连接并挂上全局监听；
   * 连接关闭后所有游戏的座位凭据仍保留在 `seats`，下一次调用重连并各自接回原位。
   */
  private ensureSocket(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.socketReady) return this.socketReady;

    const ws = new WebSocket(this.socketPath());
    this.socket = ws;
    this.socketGeneration += 1;

    this.socketReady = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.forgetSocket(ws);
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
        this.forgetSocket(ws);
        reject(new Error("无法连接游戏服务；请确认服务端 MCP_ENABLED=true"));
      });
      ws.addEventListener("close", (event) => {
        clearTimeout(timer);
        this.forgetSocket(ws);
        const reason = event.reason || "连接已关闭（Agent 接入未启用，或连接被服务端拒绝）";
        this.failPending(new Error(reason));
        if (!settled) {
          settled = true;
          reject(new Error(reason));
        }
      });
      ws.addEventListener("message", (event) => {
        void this.handleMessage(event.data);
      });
    }).catch((error: unknown) => {
      this.socketReady = null;
      throw error;
    });
    return this.socketReady;
  }

  private forgetSocket(ws: WebSocket): void {
    if (this.socket !== ws) return;
    this.socket = null;
    this.socketReady = null;
  }

  private async connect(game: GameId): Promise<GameSession> {
    let session = this.sessions.get(game);
    if (!session) {
      session = this.createSession();
      this.sessions.set(game, session);
    }
    await this.ensureSocket();
    if (session.restoredGeneration !== this.socketGeneration) {
      await this.restoreSeat(game, session);
      session.restoredGeneration = this.socketGeneration;
    }
    return session;
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
        game,
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
      // 与玩家客户端同一张永久码表：手写一份会漏掉服务端实际发出的码（如 SESSION_NOT_FOUND），
      // 死座位就会被反复拿去重连。
      if (isPermanentRoomError(error)) this.seats.delete(game);
      throw error;
    }
  }

  private async handleMessage(raw: unknown): Promise<void> {
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
      this.settleCommand(packet.id, packet.payload);
      return;
    }
    if (packet.type === "error" && typeof packet.id === "string") {
      this.rejectCommand(packet.id, packet.error);
      return;
    }
    if (packet.type !== "event" || typeof packet.event !== "string") return;

    const game = gameOfEvent(packet.event);
    const session = this.sessions.get(game);
    if (session) this.applySessionEvent(session, game, packet.event, packet.payload);
    this.resolveWaiters(packet.event, packet.payload);
  }

  private settleCommand(id: string, payload: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(payload);
  }

  private rejectCommand(id: string, value: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
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
      this.clearClosedSession(session, game, event);
      return;
    }
    if (event === "song.chat.message" && isRecord(payload)) {
      session.snapshot = {
        ...session.snapshot,
        chat: mergeChat(session.snapshot.chat, payload.message),
      };
      this.bumpState(session);
    } else {
      this.clearClosedSession(session, game, event);
    }
  }

  private clearClosedSession(session: GameSession, game: GameId, event: string): void {
    if (!event.endsWith("room.closed")) return;
    session.roomId = undefined;
    session.playerId = undefined;
    session.sessionToken = undefined;
    session.snapshot = undefined;
    session.privateState = undefined;
    this.bumpState(session);
    this.seats.delete(game);
  }

  private resolveWaiters(event: string, payload: unknown): void {
    const waiters = this.waiters.get(event);
    if (!waiters) return;
    this.waiters.delete(event);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
    }
  }

  private waitForEvent(event: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.waiters.get(event);
        if (waiters) {
          const remaining = waiters.filter((entry) => entry.resolve !== resolve);
          if (remaining.length) this.waiters.set(event, remaining);
          else this.waiters.delete(event);
        }
        resolve(undefined);
      }, timeoutMs);
      const waiter: EventWaiter = { resolve, timer };
      const waiters = this.waiters.get(event) ?? [];
      waiters.push(waiter);
      this.waiters.set(event, waiters);
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
