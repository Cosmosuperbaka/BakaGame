import { ThreeTierRateLimiter } from "../infrastructure/RateLimiter";

/**
 * WebSocket 握手的两层闸门：在途连接数 + 新建速率，都按真实客户端地址分桶。
 *
 * 只卡速率不够——每分钟开一条并长期持有就能攒出无上限的连接；只卡在途数也不够——
 * 反复开合刷的握手开销不落进任何桶。桶键来自 `resolveClientIp`，伪造该标头自造新桶的
 * 路径由回源 peer 的十倍额度封顶（口径与打点、Sentry 隧道一致）。
 */
export class WsHandshakeQuota {
  /** 桶键 → 在途连接数；连接关闭即减，归零立刻删键，因此键数不会随历史客户端增长。 */
  private readonly live = new Map<string, number>();
  private readonly rate: ThreeTierRateLimiter;
  private readonly maxConnectionsPerClient: number;

  constructor(options: {
    windowMs: number;
    ipMaxRequests: number;
    globalMaxRequests: number;
    ipMaxConnections: number;
  }) {
    this.maxConnectionsPerClient = options.ipMaxConnections;
    this.rate = new ThreeTierRateLimiter({
      windowMs: options.windowMs,
      ipMaxRequests: options.ipMaxRequests,
      globalMaxRequests: options.globalMaxRequests,
    });
  }

  /** 放行时返回归还名额要用的桶键，拒绝返回 undefined。 */
  public acquire(clientIp: string, peerIp: string): string | undefined {
    const held = this.live.get(clientIp) ?? 0;
    if (held >= this.maxConnectionsPerClient) return undefined;
    if (!this.rate.allow(clientIp, peerIp)) return undefined;
    this.live.set(clientIp, held + 1);

    return clientIp;
  }

  /** 连接关闭归还名额；未占过名额的键直接忽略。 */
  public release(key: string | undefined): void {
    if (!key) return;
    const held = (this.live.get(key) ?? 1) - 1;
    if (held > 0) this.live.set(key, held);
    else this.live.delete(key);
  }

  public liveConnections(): number {
    return [...this.live.values()].reduce((total, count) => total + count, 0);
  }
}
