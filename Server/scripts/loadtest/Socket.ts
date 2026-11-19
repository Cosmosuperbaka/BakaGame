import { applyPatch } from "fast-json-patch";

/** 与真实客户端同构的信封：只允许 id/type/traceId/roomId/sessionToken/payload 六个键。 */
export interface ClientEnvelope {
  id: string;
  type: string;
  traceId?: string;
  roomId?: string;
  sessionToken?: string;
  payload: unknown;
}

export type CommandResult =
  | { ok: true; payload: unknown; latencyMs: number }
  | { ok: false; code: string; latencyMs: number };

/**
 * 服务端状态机的「还没到时候」：驱动等一拍重发即可，与服务端健康无关。
 *
 * 这些码不计入失败率，否则压测报告会把驱动器自己的节奏抖动说成服务端故障；
 * 限流（RATE_LIMITED）不在此列 —— 那正是压力超过服务能力的信号。
 */
export const RETRYABLE_CODES: readonly string[] = [
  "PHASE_INCOMPLETE",
  "INVALID_PHASE",
  "NO_ACTIVE_ROUND",
  "NOT_ALL_READY",
  "PLAYERS_NOT_READY",
  "ACTION_PENDING",
  "ROUND_BUSY",
  "PHASE_RESULT_PENDING",
  "PLAYER_PENDING",
  "QUESTIONER_PENDING",
  "AUDIO_NOT_READY",
  "CANNOT_GUESS",
  "NOT_SETTER",
];

/** 计量窗口内的样本上限：蓄水池抽样，既压内存又保住分位数无偏。 */
const LATENCY_CAPACITY = 256;

interface Pending {
  resolve: (result: CommandResult) => void;
  sentAt: number;
  type: string;
}

interface StateChannel {
  revision: number;
  state: Record<string, unknown>;
}

export interface SocketOptions {
  url: string;
  /** 该游戏强制全量同步的命令名，补丁基准号对不上时自动补发。 */
  syncCommand: string;
  /**
   * 补发全量时要附带的信封：CEE 的 requestSync 走 sessionToken 鉴权，
   * 裸发一条会被判 SESSION_INVALID，整条连接的状态通道就废了。
   */
  syncEnvelope?: () => { roomId?: string; sessionToken?: string } | undefined;
  /** 计入状态同步通道的事件名（只有这些会被 diff，其余按普通事件计数）。 */
  stateEvents: readonly string[];
  onEvent?: (event: string, payload: unknown) => void;
  onClose?: (code: number, reason: string) => void;
}

/**
 * 单条玩家连接：负责收发、计时与字节计量。
 *
 * 计量口径与 `test/NetworkCapacity.test.ts` 一致 —— 收方向按 JSON 文本的 UTF-8 字节数，
 * 这才是服务端真正需要编码与发出的应用层出口量。
 */
export class GameSocket {
  readonly stats = {
    bytesSent: 0,
    bytesReceived: 0,
    framesSent: 0,
    framesReceived: 0,
    commandsSent: 0,
    acks: 0,
    errors: 0,
    timeouts: 0,
    retries: 0,
    ignored: 0,
  };

  private socket: WebSocket | undefined;
  private counter = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly channels = new Map<string, StateChannel>();
  private readonly latency: number[] = [];
  private latencySeen = 0;
  private closed = false;
  private stopping = false;

  constructor(private readonly options: SocketOptions) {}

  get isClosed(): boolean {
    return this.closed;
  }

  /** 本窗口的 ACK 延迟样本（供跨连接汇总分位数）。 */
  get latencySamples(): readonly number[] {
    return this.latency;
  }

  /** 清零计数，把统计范围对齐到测量窗口。 */
  beginWindow(): void {
    Object.assign(this.stats, {
      bytesSent: 0,
      bytesReceived: 0,
      framesSent: 0,
      framesReceived: 0,
      commandsSent: 0,
      acks: 0,
      errors: 0,
      timeouts: 0,
      retries: 0,
      ignored: 0,
    });
    this.latency.length = 0;
    this.latencySeen = 0;
  }

  private record(value: number): void {
    this.latencySeen += 1;
    if (this.latency.length < LATENCY_CAPACITY) {
      this.latency.push(value);
      return;
    }
    const index = Math.floor(Math.random() * this.latencySeen);
    if (index < LATENCY_CAPACITY) this.latency[index] = value;
  }

  open(timeoutMs = 8_000): Promise<void> {
    return new Promise((resolve, reject) => {
      // 不发 Origin：无 Origin 头的握手在 `isAllowedOrigin` 中直接放行。
      const socket = new WebSocket(this.options.url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("握手超时"));
      }, timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          this.socket = socket;
          resolve();
        },
        { once: true }
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("握手失败"));
        },
        { once: true }
      );
      socket.addEventListener("message", (event) =>
        this.receive(event.data as string | ArrayBuffer)
      );
      socket.addEventListener("close", (event) => {
        this.closed = true;
        const code = event.code;
        for (const [, item] of this.pending)
          item.resolve({
            ok: false,
            code: "SOCKET_CLOSED",
            latencyMs: performance.now() - item.sentAt,
          });
        this.pending.clear();
        this.options.onClose?.(code, event.reason ?? "");
      });
    });
  }

  /** 服务端按 `mode` 分发全量 / RFC-6902 补丁；本方法维护可直接读取的状态对象。 */
  state<T = Record<string, unknown>>(event: string): T | undefined {
    return this.channels.get(event)?.state as T;
  }

  revision(event: string): number {
    return this.channels.get(event)?.revision ?? 0;
  }

  async command(
    type: string,
    payload: unknown,
    envelope?: { roomId?: string; sessionToken?: string },
    timeoutMs = 12_000
  ): Promise<CommandResult> {
    if (!this.socket || this.closed) return { ok: false, code: "NOT_CONNECTED", latencyMs: 0 };
    const traceId = `lt-${Date.now().toString(36)}-${(++this.counter).toString(36)}`;
    const message: ClientEnvelope = { id: traceId, type, traceId, payload };
    if (envelope?.roomId !== undefined) message.roomId = envelope.roomId;
    if (envelope?.sessionToken !== undefined) message.sessionToken = envelope.sessionToken;
    const text = JSON.stringify(message);
    return await new Promise<CommandResult>((resolve) => {
      const sentAt = performance.now();
      this.pending.set(traceId, {
        resolve: (result) => {
          const latencyMs = performance.now() - sentAt;
          this.record(latencyMs);
          resolve({ ...result, latencyMs } as CommandResult);
        },
        sentAt,
        type,
      });
      this.stats.commandsSent += 1;
      this.stats.bytesSent += Buffer.byteLength(text, "utf8");
      this.stats.framesSent += 1;
      try {
        this.socket!.send(text);
      } catch {
        this.pending.delete(traceId);
        resolve({ ok: false, code: "SEND_FAILED", latencyMs: 0 });
      }
      setTimeout(() => {
        const item = this.pending.get(traceId);
        if (!item) return;
        this.pending.delete(traceId);
        if (this.stopping) this.stats.ignored += 1;
        else this.stats.timeouts += 1;
        resolve({ ok: false, code: "CLIENT_TIMEOUT", latencyMs: performance.now() - sentAt });
      }, timeoutMs);
    });
  }

  private receive(incoming: string | ArrayBuffer): void {
    const text = typeof incoming === "string" ? incoming : Buffer.from(incoming).toString("utf8");
    this.stats.framesReceived += 1;
    this.stats.bytesReceived += Buffer.byteLength(text, "utf8");
    let packet: Record<string, unknown>;
    try {
      packet = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = packet.type;
    if (type === "ack" || type === "error") {
      const id = packet.id as string | undefined;
      const item = id ? this.pending.get(id) : undefined;
      if (!item) return;
      this.pending.delete(id!);
      if (type === "ack") {
        this.stats.acks += 1;
        item.resolve({ ok: true, payload: packet.payload, latencyMs: 0 });
      } else {
        const code = (packet.error as { code?: string } | undefined)?.code ?? "UNKNOWN";
        // 收尾阶段的错误是驱动器自己关的窗口，前置类错误等一拍就重发，两者都不算服务端失败。
        if (this.stopping) this.stats.ignored += 1;
        else if (RETRYABLE_CODES.includes(code)) this.stats.retries += 1;
        else this.stats.errors += 1;
        item.resolve({ ok: false, code, latencyMs: 0 });
      }
      return;
    }
    if (type === "event") {
      const event = packet.event as string;
      const payload = packet.payload;
      if (this.options.stateEvents.includes(event)) this.consumeState(event, payload);
      this.options.onEvent?.(event, payload);
    }
  }

  private consumeState(event: string, payload: unknown): void {
    const envelope = payload as {
      mode?: string;
      revision?: number;
      state?: unknown;
      operations?: unknown;
      baseRevision?: number;
    } | null;
    if (!envelope || typeof envelope.mode !== "string") return;
    const current = this.channels.get(event);
    if (envelope.mode === "full") {
      this.channels.set(event, {
        revision: envelope.revision ?? 0,
        state: (envelope.state ?? {}) as Record<string, unknown>,
      });
      return;
    }
    if (envelope.mode !== "patch" || !current || !Array.isArray(envelope.operations)) return;
    if (envelope.baseRevision !== current.revision) {
      // 号对不上：与真实客户端一样主动要全量，否则后续状态一直不可用。
      void this.command(this.options.syncCommand, {}, this.options.syncEnvelope?.());
      return;
    }
    try {
      // 只把 operations 交给 applyPatch：整包信封当补丁传进去会静默地原样返回一份克隆。
      const next = applyPatch(current.state, envelope.operations, false, false);
      current.state = next.newDocument as Record<string, unknown>;
      current.revision = envelope.revision ?? current.revision;
    } catch {
      void this.command(this.options.syncCommand, {}, this.options.syncEnvelope?.());
    }
  }

  /** 离开房间后关闭；不主动 leave 的掉线会触发房间的掉线挂起流程。 */
  async leave(
    leaveCommand: string,
    envelope?: { roomId?: string; sessionToken?: string }
  ): Promise<void> {
    if (this.stopping || this.closed) {
      await this.close();
      return;
    }
    this.stopping = true;
    await this.command(leaveCommand, {}, envelope, 3_000);
    await this.close();
  }

  async close(): Promise<void> {
    this.stopping = true;
    const socket = this.socket;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
    this.closed = true;
    for (const [, item] of this.pending)
      item.resolve({ ok: false, code: "SOCKET_CLOSED", latencyMs: 0 });
    this.pending.clear();
  }
}

export const ROOM_STATE_EVENTS = ["room.snapshot", "game.privateState"] as const;
export const SONG_STATE_EVENTS = ["song.room.snapshot", "song.game.privateState"] as const;
export const CEE_STATE_EVENTS = ["cee.room.snapshot", "cee.game.privateState"] as const;
