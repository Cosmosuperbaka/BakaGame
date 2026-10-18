import { useEffect, useState } from "react";

import {
  peekPendingRestore,
  readRoomSettingsMemory,
  takePendingRestoreMemory,
  type RoomGame,
  type RoomSettingsMemoryByGame,
} from "@/lib/RoomSettingsMemory";

/** 同一房间的恢复只跑一次：StrictMode 的重挂载与后续挂载共享同一条飞行中的任务。 */
const restoreJobs = new Map<string, Promise<void>>();

const runRestoreJob = (key: string, task: () => Promise<void>): Promise<void> => {
  const existing = restoreJobs.get(key);
  if (existing) return existing;
  const job = task();
  restoreJobs.set(key, job);
  void job.finally(() => {
    if (restoreJobs.get(key) === job) restoreJobs.delete(key);
  });
  return job;
};

/**
 * 等待页的一次性「套用上次设置」：当前房间若是本机刚创建的那间（创建成功时登记过标记），
 * 挂载时取走标记并把上次的房间内设置重放给服务端；成功与否都放行界面。
 *
 * 返回 true 表示恢复仍在进行，等待页应先渲染占位——设置面板的草稿必须从恢复后的快照起步，
 * 不能让它在恢复落定前先挂载（否则草稿会停在旧值，后续一次编辑又把它盖回服务端）。
 * 服务端的广播先于命令 ACK 发出，所以等待 send 返回即可保证快照已更新。
 */
export function useRoomSettingsRestore<G extends RoomGame>(
  game: G,
  roomId: string | undefined,
  send: (memory: RoomSettingsMemoryByGame[G], roomId: string) => Promise<void>
): boolean {
  const [restoring, setRestoring] = useState(
    () =>
      Boolean(roomId) &&
      peekPendingRestore(game) === roomId &&
      readRoomSettingsMemory(game) !== null
  );

  useEffect(() => {
    if (!restoring || !roomId) return;
    let alive = true;
    void runRestoreJob(`${game}:${roomId}`, async () => {
      const memory = takePendingRestoreMemory(game, roomId);
      if (!memory) return;
      try {
        await send(memory, roomId);
      } catch {
        // 恢复失败静默：设置面板以服务端当前值起步，房主可手动调整。
      }
    }).finally(() => {
      if (alive) setRestoring(false);
    });
    return () => {
      alive = false;
    };
  }, [restoring, game, roomId, send]);

  return restoring;
}
