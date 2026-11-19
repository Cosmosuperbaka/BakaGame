import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { MusicLoginSession } from "./MusicProvider";

/** 凭据原文的稳定指纹（sha256 前 16 位）：缓存键与出口作用域用它，原文不进任何键。 */
export const fingerprintCookie = (cookie: string): string =>
  createHash("sha256").update(cookie).digest("hex").slice(0, 16);

const copySession = (session: MusicLoginSession): MusicLoginSession => ({
  cookie: session.cookie,
  account: { ...session.account },
});

/**
 * 登录态校验结果的复用缓存，带同键在途合并。
 *
 * 房间接入、开局复验与后台续期会同时到达，同凭据的并发校验合并成一次回源；
 * 校验失败不入缓存，下一次请求照常回源。返回的是副本：调用方对返回值的改写
 * 不得污染复用缓存，也不得影响其它并发调用方。
 */
export class LoginStatusCache {
  private readonly cache: LRUCache<string, MusicLoginSession>;
  private readonly inFlight = new Map<string, Promise<MusicLoginSession>>();

  constructor(options: { maxEntries: number; ttlMs: number }) {
    this.cache = new LRUCache<string, MusicLoginSession>({
      max: options.maxEntries,
      ttl: options.ttlMs,
    });
  }

  /**
   * 取复用结果，未命中则回源。`force` 绕过缓存读取（缓存里是上一次校验结果，
   * 不会替调用方换新凭据），并与普通校验分开合并，避免续期被并行打两次。
   */
  async resolve(
    key: string,
    load: () => Promise<MusicLoginSession>,
    options: { force?: boolean } = {}
  ): Promise<MusicLoginSession> {
    const reused = options.force ? undefined : this.cache.get(key);
    if (reused) return copySession(reused);
    const flightKey = `${key}:${options.force ? "refresh" : "check"}`;
    let flight = this.inFlight.get(flightKey);
    if (!flight) {
      flight = load()
        .then((verified) => {
          this.cache.set(key, verified);
          return verified;
        })
        .finally(() => {
          this.inFlight.delete(flightKey);
        });
      this.inFlight.set(flightKey, flight);
    }
    return copySession(await flight);
  }

  /** 凭据被上游轮换后，把同一份结果也登记到新凭据的键下。 */
  remember(key: string, session: MusicLoginSession): void {
    this.cache.set(key, session);
  }
}
