import { createHash } from 'node:crypto';
import { AppError } from '../domain/Errors';
import { ROOM_ID_TEST_MODE } from '../shared/Index';

/** 统一房号解析出的房间归属：增强房由本服务运行，原版房对应原版服务器上的真实房号。 */
export type CCBOriginalTarget = { source: 'original'; roomId: string; upstreamRoomId: string };
export type CCBRoomTarget = { source: 'native'; roomId: string } | CCBOriginalTarget;

const FOUR_DIGITS = /^\d{4}$/;
const ALIAS_MIN = 1000;
const ALIAS_SPAN = 9000;

/** 房号比较口径：去空白，测试房号大小写不敏感，与增强房的建房规则一致。 */
export const normalizeCCBRoomId = (roomId: string): string => {
  const trimmed = roomId.trim();
  return trimmed.toLowerCase() === ROOM_ID_TEST_MODE.toLowerCase() ? ROOM_ID_TEST_MODE : trimmed;
};

/**
 * CCB 统一房号目录：大厅、路由与会话只认一个 4 位房号。
 *
 * - 增强房的房号就是它自己的 id，由本服务的房间表持有，这里只查询不复制。
 * - 本站在原版服务器建房时直接用 4 位号作为上游房号，别名与上游号相同。
 * - 原版客户端建的房间用 UUID 作房号，按上游 id 散列取初值、线性探测避让已占用的号，
 *   同一批房间在刷新之间与服务重启之后都尽量得到同一个别名。
 * - 别名只在上游列表成功返回且该房间既已消失、又没有本地会话时释放；
 *   上游暂时不可达不会让现有别名失效。
 */
export class CCBRoomDirectory {
  private readonly aliasToUpstream = new Map<string, string>();
  private readonly upstreamToAlias = new Map<string, string>();

  constructor(private readonly hasNativeRoom: (roomId: string) => boolean) {}

  /** 该号是否已被增强房或原版房别名占用；增强房建房前据此避让。 */
  isAliasTaken(roomId: string): boolean {
    return this.aliasToUpstream.has(normalizeCCBRoomId(roomId));
  }

  /** 本站在原版服务器新建房间前占号；上游建房失败时调用方负责 `release`。 */
  claimOriginal(roomId: string): CCBOriginalTarget {
    const id = roomId.trim();
    if (!FOUR_DIGITS.test(id)) throw new AppError('INVALID_ROOM_ID', '请输入四位数字房间号');
    if (this.hasNativeRoom(id) || this.aliasToUpstream.has(id) || this.upstreamToAlias.has(id)) {
      throw new AppError('ROOM_EXISTS', '该房间号已被使用');
    }
    this.bind(id, id);
    return { source: 'original', roomId: id, upstreamRoomId: id };
  }

  release(roomId: string): void {
    const upstream = this.aliasToUpstream.get(roomId);
    if (upstream === undefined) return;
    this.aliasToUpstream.delete(roomId);
    this.upstreamToAlias.delete(upstream);
  }

  resolve(roomId: string): CCBRoomTarget | null {
    const id = normalizeCCBRoomId(roomId);
    const upstream = this.aliasToUpstream.get(id);
    if (upstream !== undefined) return { source: 'original', roomId: id, upstreamRoomId: upstream };
    return this.hasNativeRoom(id) ? { source: 'native', roomId: id } : null;
  }

  aliasOf(upstreamRoomId: string): string | undefined {
    return this.upstreamToAlias.get(upstreamRoomId);
  }

  /**
   * 以一次成功的上游列表对齐别名。`upstreamRoomIds` 必须是完整列表（含非公开房），
   * `retainedUpstreamIds` 是仍有本地会话的上游房号：建房确认途中尚未出现在列表里的房间不能被释放。
   */
  syncUpstream(upstreamRoomIds: readonly string[], retainedUpstreamIds: ReadonlySet<string>): void {
    const present = new Set(upstreamRoomIds);
    for (const [upstream, alias] of this.upstreamToAlias) {
      if (!present.has(upstream) && !retainedUpstreamIds.has(upstream)) this.release(alias);
    }
    for (const upstream of upstreamRoomIds) {
      if (this.upstreamToAlias.has(upstream)) continue;
      const alias = this.allocate(upstream);
      if (alias) this.bind(alias, upstream);
    }
  }

  clear(): void {
    this.aliasToUpstream.clear();
    this.upstreamToAlias.clear();
  }

  private bind(alias: string, upstream: string): void {
    this.aliasToUpstream.set(alias, upstream);
    this.upstreamToAlias.set(upstream, alias);
  }

  private isFree(alias: string): boolean {
    return !this.aliasToUpstream.has(alias) && !this.hasNativeRoom(alias);
  }

  /** 上游本身是 4 位号时优先原样使用；否则散列定起点再线性探测。号段耗尽时不分配，该房间不进入大厅。 */
  private allocate(upstream: string): string | null {
    if (FOUR_DIGITS.test(upstream) && this.isFree(upstream)) return upstream;
    const start = createHash('sha256').update(upstream).digest().readUInt32BE(0) % ALIAS_SPAN;
    for (let step = 0; step < ALIAS_SPAN; step++) {
      const alias = String(ALIAS_MIN + ((start + step) % ALIAS_SPAN));
      if (this.isFree(alias)) return alias;
    }
    return null;
  }
}
