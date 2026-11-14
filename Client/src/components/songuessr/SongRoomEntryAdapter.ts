import type { RoomEntryAdapter, RoomEntryPolicy } from "@/hooks/UseRoomEntryFlow";
import { errorCode } from "@/lib/ErrorMessage";
import { randomRoomId } from "@/lib/Random";
import { BASIC_PASSWORD_STEP_CODES } from "@/lib/RoomProtocolCodes";
import { waitForConnection } from "@/lib/SonGuessrWs";
import { clearSongSoloRoomId, getSavedUsername, saveSongSoloRoomId } from "@/lib/Storage";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { ROOM_ID_TEST_MODE } from "@bakagame/shared/values";

/** 猜歌接入公共入房流程：入房命令都在调用时读 store，测试换掉的 store 方法同样生效。 */
export const songRoomEntryAdapter: RoomEntryAdapter = {
  useRoomState: (roomId) => {
    const storedRoomId = useSonGuessrStore((state) => state.roomId);
    const snapshot = useSonGuessrStore((state) => state.snapshot);
    const closedAt = useSonGuessrStore((state) => state.roomClosedAt);
    return {
      alreadyIn: storedRoomId === roomId && snapshot?.roomId === roomId,
      attached: Boolean(snapshot || storedRoomId),
      closedAt,
    };
  },
  waitReady: () => waitForConnection(),
  reconnect: (roomId, signal) => useSonGuessrStore.getState().reconnectRoom(roomId, signal),
  join: (roomId, name, password, signal) =>
    useSonGuessrStore.getState().joinRoom(roomId, name, password, signal),
  createMissing: (roomId, name, signal) =>
    useSonGuessrStore.getState().createRoom(
      {
        roomId,
        name: roomId === ROOM_ID_TEST_MODE ? "Songuessr 测试房" : `${name}的房间`,
        visibility: "public",
        allowSpectators: true,
        userName: name,
      },
      signal
    ),
  roomClosedAt: () => useSonGuessrStore.getState().roomClosedAt,
  clearRoomClosed: () => useSonGuessrStore.getState().clearRoomClosed(),
  leave: () => useSonGuessrStore.getState().leaveRoom(),
  showError: (text) => useSonGuessrStore.getState().showToast(text, "error"),
};

/** 以给定房号开一间单人房；入房已被放弃时不发命令，ACK 落定才记住房号。 */
const createSoloRoom = async (roomId: string, signal: AbortSignal) => {
  if (signal.aborted) return;
  await useSonGuessrStore.getState().createRoom(
    {
      roomId,
      name: "单人模式",
      visibility: "public",
      allowSpectators: false,
      userName: getSavedUsername() || "单人玩家",
      solo: true,
      // 单人房只有一个座位，允许 MCP 接管不会影响任何人；房主仍可在房里关掉。
      allowAgents: true,
    },
    signal
  );
  if (signal.aborted) return;
  saveSongSoloRoomId(roomId);
};

/** 单人模式：不问名字直接建房，房号撞上别人的房间就换一个号再试一次。 */
export const songSoloEntryAdapter: RoomEntryAdapter = {
  ...songRoomEntryAdapter,
  enterSolo: async (roomId, signal) => {
    try {
      await createSoloRoom(roomId, signal);
      return roomId;
    } catch (error) {
      if (signal.aborted || errorCode(error) !== "ROOM_EXISTS") throw error;
    }
    const nextRoomId = randomRoomId();
    await createSoloRoom(nextRoomId, signal);
    return nextRoomId;
  },
  forgetRoom: clearSongSoloRoomId,
};

/**
 * 猜歌现状：缺名字弹框、缺密码与密码错误及尝试过多都留在密码步、卸载时退房、各种回退一律替换历史、
 * 不因脱离房间自行回大厅，房间被关的检查排在入房之后，主动离开后的关闭不再理会。
 */
export const SONG_ROOM_ENTRY_POLICY: RoomEntryPolicy = {
  missingName: "prompt",
  passwordCodes: BASIC_PASSWORD_STEP_CODES,
  leaveOn: "unmount",
  replaceOnExit: true,
  exitWhenDetached: false,
  closeCheck: "afterEntry",
  closeAfterLeave: "ignore",
};
