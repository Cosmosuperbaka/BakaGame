import { WS_HANDSHAKE_LEASE_MS } from "../config/Constants";
import { ThreeTierRateLimiter } from "../infrastructure/RateLimiter";

/**
 * 一次握手占下的名额。`confirm` 在连接真正打开时调用，`release` 在连接关闭或握手失败时调用，
 * 两者都幂等；未在时限内确认的租约会自行归还。
 */
export interface HandshakeLease {
  confirm(): void;
  release(): void;
}

/**
 * WebSocket 握手的两层闸门：在途连接数 + 新建速率，都按真实客户端地址分桶。
 *
 * 只卡速率不够——每分钟开一条并长期持有就能攒出无上限的连接；只卡在途数也不够——
 * 反复开合刷的握手开销不落进任何桶。桶键来自 `resolveClientIp`，伪造该标头自造新桶的
 * 路径由回源 peer 的十倍额度封顶（口径与打点、Sentry 隧道一致）。
 *
 * 名额以租约持有：升级钩子里占位，但升级可能在钩子之后失败（运行时拒绝畸形握手、后续步骤抛错、
 * 客户端中途断开），这时既不会触发 open 也不会触发 close，只靠 close 归还就会永久泄漏。
 */
export class WsHandshakeQuota {
  /** 桶键 → 在途连接数（含尚未确认的租约）；归零立刻删键，因此键数不会随历史客户端增长。 */
  private readonly live = new Map<string, number>();
  private readonly rate: ThreeTierRateLimiter;
  private readonly maxConnectionsPerClient: number;
  private readonly leaseMs: number;

  constructor(options: {
    windowMs: number;
    ipMaxRequests: number;
    globalMaxRequests: number;
    ipMaxConnections: number;
    /** 租约确认时限；缺省取常量，测试注入短值。 */
    leaseMs?: number;
  }) {
    this.maxConnectionsPerClient = options.ipMaxConnections;
    this.leaseMs = options.leaseMs ?? WS_HANDSHAKE_LEASE_MS;
    this.rate = new ThreeTierRateLimiter({
      windowMs: options.windowMs,
      ipMaxRequests: options.ipMaxRequests,
      globalMaxRequests: options.globalMaxRequests,
    });
  }

  /** 放行返回租约，拒绝返回 undefined。 */
  public reserve(clientIp: string, peerIp: string): HandshakeLease | undefined {
    if ((this.live.get(clientIp) ?? 0) >= this.maxConnectionsPerClient) return undefined;
    if (!this.rate.allow(clientIp, peerIp)) return undefined;
    this.adjust(clientIp, 1);

    let state: "pending" | "held" | "expired" | "released" = "pending";
    const timer = setTimeout(() => {
      if (state !== "pending") return;
      state = "expired";
      this.adjust(clientIp, -1);
    }, this.leaseMs);
    timer.unref();

    return {
      confirm: () => {
        if (state === "pending") clearTimeout(timer);
        // 握手慢于时限才打开的连接：名额已被自动归还，重新记上，保证在途数与真实连接一致。
        else if (state === "expired") this.adjust(clientIp, 1);
        else return;
        state = "held";
      },
      release: () => {
        if (state === "released") return;
        if (state === "pending") clearTimeout(timer);
        if (state !== "expired") this.adjust(clientIp, -1);
        state = "released";
      },
    };
  }

  public liveConnections(): number {
    return [...this.live.values()].reduce((total, count) => total + count, 0);
  }

  private adjust(key: string, delta: number): void {
    const next = (this.live.get(key) ?? 0) + delta;
    if (next > 0) this.live.set(key, next);
    else this.live.delete(key);
  }
}
