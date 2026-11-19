import { useAutoSave } from "./UseAutoSave";

/**
 * 三款等待页共用的设置自动保存：防抖、串行队列与卸载冲刷交给 `useAutoSave`，
 * 这里只固定两条各款都必须一致的口径——发送边界读当前房态、记忆在服务端接受之后才写。
 */
export function useWaitingSettingsSave<T, Room, Sent>(options: {
  value: T;
  enabled: boolean;
  /**
   * 发送边界：返回 `null` 表示已换房或已离开等待阶段，这次保存连同记忆一起丢弃。
   * `enabled` 证明不了这一点——防抖窗口内房主可能已经开局或退房（Engineering §6）。
   */
  liveRoom: () => Room | null;
  /** 真正发出命令，返回提交的载荷；没有可提交的内容时返回 `null`，记忆也不写。 */
  send: (value: T, live: Room) => Promise<Sent | null>;
  /** 被拒的值与被丢弃的草稿都不该留进下次建房的记忆，所以只在 `send` 落定后调用。 */
  remember?: (sent: Sent) => void;
  onError: (error: unknown) => void;
}): void {
  const { value, enabled, liveRoom, send, remember, onError } = options;
  useAutoSave(
    value,
    async (next) => {
      const live = liveRoom();
      if (!live) return;
      const sent = await send(next, live);
      if (sent !== null) remember?.(sent);
    },
    { enabled, onError }
  );
}
