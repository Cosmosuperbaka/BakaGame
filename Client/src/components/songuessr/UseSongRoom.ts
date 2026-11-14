import { useState } from "react";
import { useParams } from "react-router";
import { useCommandRunner } from "@/hooks/UseCommandRunner";
import { useRoomEntryFlow } from "@/hooks/UseRoomEntryFlow";
import { useSongMusicSessionSync } from "@/components/songuessr/UseSongMusicSessionSync";
import {
  SONG_ROOM_ENTRY_POLICY,
  songRoomEntryAdapter,
  songSoloEntryAdapter,
} from "@/components/songuessr/SongRoomEntryAdapter";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { SONGUESSR_COMMAND_POLICY, type SonGuessrCommandMap } from "@/lib/SonGuessrWs";
import { getSongSoloRoomId, normalizeRoomId } from "@/lib/Storage";
import { randomRoomId } from "@/lib/Random";
import type { SonGuessrCommand, SonGuessrPayload } from "@bakagame/shared";
import { errorCode, errorText } from "@/lib/ErrorMessage";

/**
 * 「发一条指令，失败落到横幅提示」的组件侧形状：命令名与载荷沿用 store `sendCommand` 的约束，
 * 组件里写 `run: (type: string, ...)` 会把这条通道又放宽回任意字符串。
 */
export type SongRunCommand = <TCommand extends SonGuessrCommand>(
  type: TCommand,
  payload?: SonGuessrPayload<TCommand>,
  success?: string
) => Promise<void>;

/**
 * 猜歌房间页的装配：房号（单人房记在本机、撞号会换）、音乐凭据装载、命令执行与公共入房流程。
 * 入房状态机本身在 `useRoomEntryFlow`，这里只接猜歌专属的部分。
 */
export function useSongRoom({ solo = false }: { solo?: boolean } = {}) {
  const { roomId: routeRoomId = "" } = useParams();
  const [soloRoomId, setSoloRoomId] = useState(() =>
    solo ? getSongSoloRoomId() || randomRoomId() : ""
  );
  const roomId = solo ? soloRoomId : normalizeRoomId(routeRoomId);
  const exitPath = solo ? "/" : "/songuessr";

  const snapshot = useSonGuessrStore((state) => state.snapshot);
  const privateState = useSonGuessrStore((state) => state.privateState);
  const connected = useSonGuessrStore((state) => state.connected);
  const sendCommand = useSonGuessrStore((state) => state.sendCommand);
  const showToast = useSonGuessrStore((state) => state.showToast);

  const { cancelMusicSessionUpload } = useSongMusicSessionSync({
    connected,
    snapshot,
    privateState,
    roomId,
    sendCommand,
    showToast,
  });

  const { run, isPending } = useCommandRunner<SonGuessrCommandMap>({
    send: sendCommand,
    policy: SONGUESSR_COMMAND_POLICY,
    pollSync: () => {
      void sendCommand("song.room.requestSync").catch(() => {});
    },
    onError: (error) => {
      if (errorCode(error) === "MUSIC_SESSION_INVALID") {
        cancelMusicSessionUpload();
        showToast(errorText(error, "音乐登录会话已失效，请重新确认登录状态"), "error");
        return;
      }
      showToast(errorText(error, "操作失败"), "error");
    },
    lock: "command",
  });

  const entry = useRoomEntryFlow({
    roomId,
    exitPath,
    adapter: solo ? songSoloEntryAdapter : songRoomEntryAdapter,
    policy: SONG_ROOM_ENTRY_POLICY,
    onRoomSwitched: setSoloRoomId,
  });

  const runCommand: SongRunCommand = async (type, payload, success) => {
    await run(type, payload, {
      onSuccess: success ? () => showToast(success, "success") : undefined,
    });
  };

  return {
    ...entry,
    roomId,
    snapshot,
    privateState,
    runCommand,
    isPending,
    sendCommand,
  };
}
