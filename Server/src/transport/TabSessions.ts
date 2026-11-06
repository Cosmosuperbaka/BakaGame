import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { TabSessionClaimAck } from "../shared/TabSession";

/**
 * 等现持有者应答的上限。只有「同一份身份已被一条在线连接持有」才会等：
 * 刷新时旧连接通常先断开，走不到这里；旧连接迟迟没断时多等这一下，好过把刷新误判成复制。
 */
export const TAB_HOLDER_PROBE_TIMEOUT_MS = 1_500;

const mintTabToken = (): string => randomBytes(32).toString("base64url");

/** 服务端只拿摘要当身份键：连接记录、席位与日志里都不出现可重放的明文。 */
export const tabKeyOf = (token: string): string => createHash("sha256").update(token).digest("hex");

type SendProbe = (nonce: string) => void;

interface TabHolder {
  connectionId: string;
  sendProbe: SendProbe;
}

interface PendingProbe {
  connectionId: string;
  settle: (alive: boolean) => void;
}

export interface TabClaim extends TabSessionClaimAck {
  key: string;
}

/**
 * 标签页身份的在线索引，只存在于进程内存，按连接登记、断开即摘，规模不超过在线连接数。
 *
 * 身份本身不落服务端：令牌是持有者凭证，服务端重启后标签页带着原令牌回来，算出同一个键，
 * 落盘恢复的席位就能原样认回来。客户端自造令牌也只是一张没有任何席位的新标签页，
 * 它算不出别人的键，所以这里不需要、也不应该维护一份「发过哪些令牌」的名单。
 *
 * 这份索引只回答一件事：同一份身份此刻是不是被另一张开着的标签页占着。
 * 复制标签页与 `window.open` 会连 sessionStorage 一起继承，靠本地判定仍可能漏网，
 * 这里是最后一道：现持有者还能应答探测，后来者就换一份新身份。
 */
export class TabSessions {
  readonly serverEpoch = randomUUID();
  private readonly holders = new Map<string, TabHolder>();
  private readonly keysByConnection = new Map<string, string>();
  private readonly pendingProbes = new Map<string, PendingProbe>();

  constructor(private readonly probeTimeoutMs = TAB_HOLDER_PROBE_TIMEOUT_MS) {}

  /** 站点连接领取身份：没带令牌就发新的，带了就续用，被占用时换一份新的。 */
  async claim(
    connectionId: string,
    presented: string | undefined,
    sendProbe: SendProbe
  ): Promise<TabClaim> {
    if (!presented) return this.adopt(connectionId, mintTabToken(), sendProbe, false);
    const free = await this.isFree(tabKeyOf(presented), connectionId);
    return free
      ? this.adopt(connectionId, presented, sendProbe, false)
      : this.adopt(connectionId, mintTabToken(), sendProbe, true);
  }

  /** 只有被探测的那条连接发来的应答才算数：别的连接知道 nonce 也证明不了持有者还活着。 */
  confirmAlive(connectionId: string, nonce: string): void {
    const pending = this.pendingProbes.get(nonce);
    if (pending?.connectionId === connectionId) pending.settle(true);
  }

  /** 连接关闭：摘掉在线索引，正在等它应答的后来者不必等到超时。 */
  release(connectionId: string): void {
    for (const pending of [...this.pendingProbes.values()])
      if (pending.connectionId === connectionId) pending.settle(false);
    const key = this.keysByConnection.get(connectionId);
    if (key === undefined) return;
    this.keysByConnection.delete(connectionId);
    if (this.holders.get(key)?.connectionId === connectionId) this.holders.delete(key);
  }

  get size(): number {
    return this.holders.size;
  }

  private adopt(
    connectionId: string,
    token: string,
    sendProbe: SendProbe,
    rotated: boolean
  ): TabClaim {
    const key = tabKeyOf(token);
    this.holders.set(key, { connectionId, sendProbe });
    this.keysByConnection.set(connectionId, key);
    return { key, token, rotated, serverEpoch: this.serverEpoch };
  }

  /**
   * 循环而不是判一次：探测跨了一次等待，期间可能有第三条连接已经认领，
   * 只判一次会让两条连接同时持有同一份身份。
   */
  private async isFree(key: string, connectionId: string): Promise<boolean> {
    for (;;) {
      const holder = this.holders.get(key);
      if (!holder || holder.connectionId === connectionId) return true;
      if (await this.isAlive(holder)) return false;
      if (this.holders.get(key) === holder) this.holders.delete(key);
    }
  }

  private isAlive(holder: TabHolder): Promise<boolean> {
    return new Promise((resolve) => {
      const nonce = randomUUID();
      const timer = setTimeout(() => settle(false), this.probeTimeoutMs);
      const settle = (alive: boolean) => {
        clearTimeout(timer);
        this.pendingProbes.delete(nonce);
        resolve(alive);
      };
      this.pendingProbes.set(nonce, { connectionId: holder.connectionId, settle });
      try {
        holder.sendProbe(nonce);
      } catch {
        // 发不出去说明这条连接已经死了，不必等到超时。
        settle(false);
      }
    });
  }
}
