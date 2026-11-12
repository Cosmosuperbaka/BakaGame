/**
 * 进程内发号：`<前缀>_<base36 序号>`。短号会在快照与每帧状态里反复出现，换成 UUID
 * 会抬高每帧体积，所以保留计数器。
 *
 * 计数器每次启动从 0 重来，而快照恢复回来的房间带着已用过的号：恢复后必须 `absorb`，
 * 把计数器抬到快照里最大的序号之上，否则新号会撞上旧号（座位串号、对局记录错挂）。
 */
export class IdCounter {
  private value = 0;

  /**
   * @param pattern 能被回收的号的形状，第一个捕获组是 base36 序号；
   *   只认本玩法自己发的前缀，派生的标签页座位号等不能落进来，否则计数器会被哈希撑爆。
   */
  constructor(private readonly pattern: RegExp) {}

  next(prefix: string): string {
    this.value += 1;
    return `${prefix}_${this.value.toString(36)}`;
  }

  /** 遍历快照里的全部字符串，按形状回收已用过的最大序号。 */
  absorb(snapshot: unknown): void {
    const seen = new Set<object>();
    const visit = (value: unknown): void => {
      if (typeof value === "string") {
        const matched = this.pattern.exec(value);
        if (!matched?.[1]) return;
        const index = Number.parseInt(matched[1], 36);
        if (Number.isFinite(index) && index > this.value) this.value = index;
        return;
      }
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    };
    visit(snapshot);
  }
}
