import { createEvent } from "../transport/Packets";

/**
 * 大厅房间列表的合并窗。
 *
 * 列表帧是「每帧自带完整视图」的全量刷新帧，而且对全体订阅者内容一致：一次改名就向所有人
 * 重发整张表，成本 O(订阅者 × 房数)。建房、加入、离开、改名在满载大厅里可以按秒十几次地
 * 重复触发，所以窗内的多次变更并为一次下发不丢信息，只把最后一次变更的可见时刻推迟至多一个窗口。
 *
 * 新订阅者不走这条链：它要么立刻拿到一份完整列表（`sendTo`），要么一份都收不到，合并窗对它
 * 没有意义；把订阅算进扇出，只会让「一批人同时打开大厅」变成 O(订阅者²)。
 */
export const LOBBY_MERGE_WINDOW_MS = 250;

/**
 * 尾沿调度：把「delayMs 之后收敛一次」交给宿主。默认挂真实定时器；测试注入后按注入时钟驱动，
 * 承载门禁与服务用例才不会把「虚拟 250 毫秒」摊到真实墙钟的抖动上。
 */
export type LobbyFanoutSchedule = (flush: () => void, delayMs: number) => void;

export interface LobbyFanoutOptions {
  /** 事件名取 shared 的常量：传输层的积压丢弃口径按同一个名字判定，改一处就得同时改到。 */
  event: string;
  now: () => number;
  broadcast: (payload: unknown) => void;
  summaries: () => unknown;
  windowMs?: number;
  schedule?: LobbyFanoutSchedule;
}

export class LobbyFanout {
  private publishedAt = Number.NEGATIVE_INFINITY;
  private dirty = false;
  private flushScheduled = false;

  constructor(private readonly options: LobbyFanoutOptions) {}

  /** 房间增减或摘要变化时调用：窗口外的变更立刻下发，窗口内的交给已经挂上的尾沿。 */
  request(): void {
    this.dirty = true;
    const windowMs = this.options.windowMs ?? LOBBY_MERGE_WINDOW_MS;
    const elapsedMs = this.options.now() - this.publishedAt;
    if (elapsedMs >= windowMs) {
      this.publish();
      return;
    }
    // 尾沿负责「突发之后立刻安静下来」这一头的收敛：没有它，窗口末尾那次变更要等下一个
    // 事件才可能被带出去，而空闲大厅的下一个事件可能是几分钟后。
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      (this.options.schedule ?? defaultSchedule)(this.publish, windowMs - elapsedMs);
    }
  }

  /** 只给这一条连接下发当前列表；订阅时用这条路径。 */
  sendTo(connection: { send: (payload: unknown) => void }): void {
    connection.send(createEvent(this.options.event, this.options.summaries()));
  }

  private publish = (): void => {
    this.flushScheduled = false;
    // 尾沿不撤销：挂上就让它到点跑一次，无变更时在这里止步，省掉「谁在窗口末尾又改了一次」
    // 这类竞态下的定时器换手的代价。
    if (!this.dirty) return;
    this.dirty = false;
    this.publishedAt = this.options.now();
    this.options.broadcast(createEvent(this.options.event, this.options.summaries()));
  };
}

const defaultSchedule = (flush: () => void, delayMs: number): void => {
  const timer = setTimeout(flush, delayMs);
  // 停机排空不该被一次大厅变更的尾沿拖住：列表本来就是可丢帧，进程要走了就让它跟着走。
  timer.unref();
};
