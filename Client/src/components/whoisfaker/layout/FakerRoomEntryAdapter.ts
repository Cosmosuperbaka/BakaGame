import type { RoomEntryAdapter, RoomEntryPolicy } from "@/hooks/UseRoomEntryFlow";
import { BASIC_PASSWORD_STEP_CODES } from "@/lib/RoomProtocolCodes";
import { waitForConnection } from "@/lib/WhoIsFakerWs";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";

/** 卧底接入公共入房流程：入房命令都在调用时读 store，测试换掉的 store 方法同样生效。 */
export const fakerRoomEntryAdapter: RoomEntryAdapter = {
  useRoomState: (roomId) => {
    const storeRoomId = useWhoIsFakerStore((s) => s.roomId);
    const snapshot = useWhoIsFakerStore((s) => s.snapshot);
    const closedAt = useWhoIsFakerStore((s) => s.roomClosedAt);
    return {
      alreadyIn: storeRoomId === roomId && snapshot?.roomId === roomId,
      attached: Boolean(snapshot || storeRoomId),
      closedAt,
    };
  },
  waitReady: () => waitForConnection(8000),
  reconnect: (roomId, signal) => useWhoIsFakerStore.getState().reconnectRoom(roomId, signal),
  join: (roomId, name, password, signal) =>
    useWhoIsFakerStore.getState().joinRoom(roomId, name, password, signal),
  createMissing: (roomId, name, signal) =>
    useWhoIsFakerStore.getState().createRoom(
      {
        roomId,
        name: `${name}的房间`,
        visibility: "public",
        allowSpectators: true,
        userName: name,
      },
      signal
    ),
  roomClosedAt: () => useWhoIsFakerStore.getState().roomClosedAt,
  clearRoomClosed: () => useWhoIsFakerStore.getState().clearRoomClosed(),
  leave: () => useWhoIsFakerStore.getState().leaveRoom(),
  showError: (text) => useWhoIsFakerStore.getState().showToast(text, "error"),
};

/**
 * 卧底现状：缺名字弹框、只认缺密码与密码错误、卸载时退房、失败回大厅不替换历史、脱离房间自行回大厅，
 * 房间被关的检查排在入房之前，主动离开后的关闭照样替换回大厅。
 */
export const FAKER_ROOM_ENTRY_POLICY: RoomEntryPolicy = {
  missingName: "prompt",
  passwordCodes: BASIC_PASSWORD_STEP_CODES,
  leaveOn: "unmount",
  replaceOnExit: false,
  exitWhenDetached: true,
  closeCheck: "beforeEntry",
  closeAfterLeave: "exit",
};
