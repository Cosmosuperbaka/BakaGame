import type { CEERoomSnapshot } from "@bakagame/shared";
import { useCEEStore } from "@/stores/UseCEEStore";

/**
 * 自动保存在发出命令的那一刻核对：Store 里当前快照仍是草稿所属的房间、且仍在等待阶段才允许提交。
 * 回调里的 `enabled` 证明不了这一点——防抖窗口内房主点了开始或退房，组件卸载冲刷出的仍是旧草稿，
 * 命令却会落到新阶段或新房间的连接上。返回当前快照；不满足时返回 `null`，调用方丢弃这次保存。
 */
export function waitingSnapshotOf(roomId: string): CEERoomSnapshot | null {
  const snapshot = useCEEStore.getState().snapshot;
  return snapshot?.roomId === roomId && snapshot.phase === "waiting" ? snapshot : null;
}
