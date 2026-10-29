import type { SnapshottedRoom, RoomSnapshotGame } from "../shared/RoomSnapshot";
import type { RoomSnapshotStore } from "../infrastructure/RoomSnapshotStore";
import { SNAPSHOT_MAX_DOWNTIME_MS } from "../config/Constants";
import { describeError } from "../infrastructure/EventLogger";

/** 一款游戏的快照出入两端；三款服务的实现形态一致，编排只按名字取用。 */
export interface RoomSnapshotService {
  exportSnapshots(): SnapshottedRoom[];
  restoreSnapshots(rooms: readonly SnapshottedRoom[], savedAt: number): number;
}

export interface RoomSnapshotTargets {
  store: RoomSnapshotStore;
  /** 本进程负责的游戏（片角色）；只有这些会写、也只有这些会读。 */
  games: readonly RoomSnapshotGame[];
  services: Record<RoomSnapshotGame, RoomSnapshotService>;
  now?: () => number;
  logger?: {
    info(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
  };
}

export interface SnapshotSaveSummary {
  /** 各游戏写成功的房间数。 */
  saved: Partial<Record<RoomSnapshotGame, number>>;
}

export interface SnapshotRestoreSummary {
  restored: Partial<Record<RoomSnapshotGame, number>>;
  /** 因停机过久被丢弃的游戏。 */
  discarded: RoomSnapshotGame[];
}

/**
 * 停机保存：按片角色逐款落盘。
 *
 * 单款失败不影响其余，也不抛出 —— 它跑在优雅停机的预算里，抛错只会让后面的
 * 排空与关监听来不及执行，代价比少存一款游戏大得多。
 */
export const saveRoomSnapshots = (
  targets: RoomSnapshotTargets,
  savedAt: number
): SnapshotSaveSummary => {
  const saved: Partial<Record<RoomSnapshotGame, number>> = {};
  for (const game of targets.games) {
    try {
      saved[game] = targets.store.save(game, targets.services[game].exportSnapshots(), savedAt);
    } catch (error) {
      // 写盘失败由 store 自己降级记日志；走到这里的是导出侧（服务把房间摊平成快照）抛错，
      // store 看不到它，不在这里记就成了「停机后房间全没了却查不到原因」。
      targets.logger?.error("房间快照导出失败，该游戏本次停机不保存", {
        game,
        ...describeError(error),
      });
    }
  }
  return { saved };
};

/**
 * 启动恢复：按片角色逐款读回。
 *
 * 停机过久（超过空闲超时）时整款放弃：那些房间按现有规则本来就该被回收，
 * 把「过期房间」恢复回来等于绕过回收规则，玩家回来看到的还是一局早已结束的对局。
 */
export const restoreRoomSnapshots = (targets: RoomSnapshotTargets): SnapshotRestoreSummary => {
  const now = (targets.now ?? Date.now)();
  const restored: Partial<Record<RoomSnapshotGame, number>> = {};
  const discarded: RoomSnapshotGame[] = [];

  for (const game of targets.games) {
    const loaded = targets.store.load(game);
    if (!loaded) continue;
    // 读到即消费：无论恢复成功、失败还是过期丢弃，同一份快照都不能在下一次启动里再用。
    targets.store.clear(game);
    const downtimeMs = Math.max(0, now - loaded.savedAt);
    if (downtimeMs > SNAPSHOT_MAX_DOWNTIME_MS) {
      discarded.push(game);
      targets.logger?.info("停机过久，丢弃房间快照", { game, downtimeMs });
      continue;
    }
    try {
      restored[game] = targets.services[game].restoreSnapshots(loaded.rooms, loaded.savedAt);
    } catch (error) {
      // 单款恢复失败不能让其余游戏与整个进程起不来：这一款退回「重启即清空」的旧行为。
      restored[game] = 0;
      targets.logger?.error("房间快照恢复失败，已跳过该游戏", { game, ...describeError(error) });
    }
  }

  return { restored, discarded };
};
