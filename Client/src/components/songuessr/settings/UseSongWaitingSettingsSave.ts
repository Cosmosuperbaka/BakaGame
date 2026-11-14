import { useSettingsReadOnly } from "@/components/common/room/settings/Layout";
import { errorText } from "@/lib/ErrorMessage";
import { useAutoSave } from "@/hooks/UseAutoSave";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import type { SonGuessrRoomSnapshot } from "@bakagame/shared";

/**
 * 发送边界：阶段切换会直接卸载等待设置树，旧 props 的 enabled 来不及变为 false，
 * 所以防抖、卸载刷新与飞行中的后续草稿都在这里读 Store，房间不是这一间或已离开等待阶段就不发。
 * 返回是否真的发出了命令。
 */
async function saveWaitingSettings(
  roomId: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const state = useSonGuessrStore.getState();
  if (state.snapshot?.roomId !== roomId || state.snapshot.phase !== "waiting") return false;
  await state.sendCommand("song.room.updateSettings", payload);
  return true;
}

/**
 * 三个设置面板共用的自动保存：只有房主（非只读）且房间仍在等待阶段才保存，失败弹出服务端给的原因。
 * remember 在服务端接受之后才调用：被拒的值与被丢弃的草稿都不该留进下次建房的记忆。
 * enabled 是面板自己的附加门槛（例如私密房间还没有密码）。
 */
export function useSongWaitingSettingsSave<T extends Record<string, unknown>>(
  snapshot: SonGuessrRoomSnapshot,
  payload: T,
  { enabled = true, remember }: { enabled?: boolean; remember?: (payload: T) => void } = {}
) {
  const readOnly = useSettingsReadOnly();
  const showToast = useSonGuessrStore((state) => state.showToast);
  useAutoSave(
    payload,
    async (value) => {
      if (await saveWaitingSettings(snapshot.roomId, value)) remember?.(value);
    },
    {
      enabled: !readOnly && snapshot.phase === "waiting" && enabled,
      onError: (error) => showToast(errorText(error, "保存设置失败"), "error"),
    }
  );
}
