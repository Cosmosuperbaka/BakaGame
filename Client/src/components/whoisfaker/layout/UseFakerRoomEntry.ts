import { useCallback, useEffect, useRef, useState } from "react";
import { errorCode, errorText } from "@/lib/ErrorMessage";
import { getSavedUsername, saveUsername } from "@/lib/Storage";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { waitForConnection } from "@/lib/WhoIsFakerWs";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { isValidRoomId } from "@bakagame/shared/values";

/**
 * 卧底房间的入房事务：直链进房、恢复会话、问名字、问密码、房间不存在就地建房、被关闭或主动离开。
 * `mountTime` 与 `entryRef` 被「房间被关」与入房两个 effect 共享，必须留在同一个钩子里。
 */
export function useFakerRoomEntry(roomId: string) {
  const navigate = usePageNavigate();
  const storeRoomId = useWhoIsFakerStore((s) => s.roomId);
  const snapshot = useWhoIsFakerStore((s) => s.snapshot);
  const createRoom = useWhoIsFakerStore((s) => s.createRoom);
  const joinRoom = useWhoIsFakerStore((s) => s.joinRoom);
  const reconnectRoom = useWhoIsFakerStore((s) => s.reconnectRoom);
  const showToast = useWhoIsFakerStore((s) => s.showToast);
  const roomClosedAt = useWhoIsFakerStore((s) => s.roomClosedAt);
  const alreadyInRoom = storeRoomId === roomId && snapshot?.roomId === roomId;

  const [joining, setJoining] = useState(!alreadyInRoom);
  // 从分享链接直接进房、本地又没存过名字时，先问名字再进房，而不是踢回大厅。
  const [needsName, setNeedsName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  // 私密房：不带密码的加入被拒后先问密码；名字沿用已确认的那个
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [pendingJoinName, setPendingJoinName] = useState("");
  const [mountTime] = useState(() => Date.now());
  const entryRef = useRef<AbortController | null>(null);

  // 挂载与卸载时清理残留的 roomClosedAt
  useEffect(() => {
    useWhoIsFakerStore.getState().clearRoomClosed();
    return () => {
      useWhoIsFakerStore.getState().clearRoomClosed();
    };
  }, []);

  // 房间被服务端关闭或席位被替换：这是一个明确的事件，无论当前是否正在加入
  // 都必须立刻退回大厅，否则加入流程中被关闭会一直停在加载态。
  useEffect(() => {
    if (roomClosedAt && roomClosedAt >= mountTime) {
      entryRef.current?.abort();
      useWhoIsFakerStore.getState().clearRoomClosed();
      void navigate("/whoisfaker", { replace: true });
    }
  }, [mountTime, roomClosedAt, navigate]);

  // 主动离开等其它原因导致的脱离房间。等用户填名字或密码的这段时间同样没有 snapshot，
  // 但那是正常状态，不能当成房间已关闭。
  useEffect(() => {
    if (!joining && !needsName && !needsPassword && !snapshot && !storeRoomId)
      void navigate("/whoisfaker");
  }, [joining, needsName, needsPassword, snapshot, storeRoomId, navigate]);

  /** 用给定名字加入房间；房间不存在就以该名字开一间。 */
  const enterWithName = useCallback(
    async (name: string, signal: AbortSignal, password?: string) => {
      if (!roomId || signal.aborted) return;
      setJoining(true);
      try {
        await joinRoom(roomId, name, password, signal);
        if (signal.aborted) return;
        setNeedsPassword(false);
        setJoining(false);
      } catch (e) {
        if (signal.aborted) return;
        const code = errorCode(e);
        if (code === "PASSWORD_INCORRECT" || code === "PASSWORD_REQUIRED") {
          // 密码缺失与密码错误都回到密码框重输，而不是踢回大厅
          setPendingJoinName(name);
          setPasswordDraft("");
          setNeedsPassword(true);
          setJoining(false);
        } else if (code === "ROOM_NOT_FOUND") {
          try {
            await createRoom(
              {
                roomId,
                name: `${name}的房间`,
                visibility: "public",
                allowSpectators: true,
                userName: name,
              },
              signal
            );
            if (signal.aborted) return;
            setJoining(false);
          } catch (createErr) {
            if (signal.aborted) return;
            showToast(errorText(createErr, "创建房间失败"), "error");
            void navigate("/whoisfaker");
          }
        } else {
          showToast(errorText(e, "加入房间失败"), "error");
          void navigate("/whoisfaker");
        }
      }
    },
    [roomId, joinRoom, createRoom, showToast, navigate]
  );

  // 入房事务归属路由房间，而非 snapshot；取消后的 ACK 释放由 Store 负责。
  useEffect(() => {
    const entry = new AbortController();
    entryRef.current = entry;
    const { signal } = entry;
    const cleanup = () => {
      entry.abort();
      if (entryRef.current === entry) entryRef.current = null;
    };
    if (!roomId || alreadyInRoom) return cleanup;

    if (!isValidRoomId(roomId)) {
      showToast("房间号无效，请检查链接", "error");
      void navigate("/whoisfaker", { replace: true });
      return cleanup;
    }

    useWhoIsFakerStore.getState().clearRoomClosed();
    const tryEnter = async () => {
      setJoining(true);
      try {
        await waitForConnection(8000);
      } catch {
        if (signal.aborted) return;
        showToast("连接服务器超时，请刷新重试", "error");
        void navigate("/whoisfaker");
        return;
      }
      if (signal.aborted) return;

      let restored: boolean;
      try {
        restored = await reconnectRoom(roomId, signal);
      } catch (error) {
        if (signal.aborted) return;
        showToast(errorText(error, "恢复房间失败，请重试"), "error");
        void navigate("/whoisfaker");
        return;
      }
      if (signal.aborted) return;
      if (restored) {
        setJoining(false);
        return;
      }
      const closedAt = useWhoIsFakerStore.getState().roomClosedAt;
      if (closedAt !== null && closedAt >= mountTime) return;

      const name = getSavedUsername();
      if (!name) {
        setJoining(false);
        setNameDraft("");
        setNeedsName(true);
        return;
      }
      await enterWithName(name, signal);
      if (signal.aborted) return;
    };

    void tryEnter();
    return cleanup;
  }, [roomId, mountTime]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConfirmName = useCallback(async () => {
    const name = nameDraft.trim();
    if (!name) {
      showToast("请输入用户名", "error");
      return;
    }
    saveUsername(name);
    setNeedsName(false);
    const signal = entryRef.current?.signal;
    if (!signal || signal.aborted) return;
    await enterWithName(name, signal);
    if (signal.aborted) return;
  }, [nameDraft, showToast, enterWithName]);

  const handleConfirmPassword = useCallback(async () => {
    if (!pendingJoinName || !passwordDraft.trim()) return;
    setNeedsPassword(false);
    const signal = entryRef.current?.signal;
    if (!signal || signal.aborted) return;
    await enterWithName(pendingJoinName, signal, passwordDraft);
  }, [pendingJoinName, passwordDraft, enterWithName]);

  // 先换页、页面卸载后再退房：退房会清空快照，若先退再走，过渡拍下的旧页就成了加入中的转圈，
  // 清空还会触发上面「脱离房间」的 effect 再导航一次，打断进行中的过渡（DesignGuide §8）。
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (!exiting) return;
    return () => void useWhoIsFakerStore.getState().leaveRoom();
  }, [exiting]);
  const handleLeave = useCallback(() => {
    entryRef.current?.abort();
    setExiting(true);
    void navigate("/whoisfaker");
  }, [navigate]);

  return {
    joining,
    needsName,
    needsPassword,
    nameDraft,
    setNameDraft,
    passwordDraft,
    setPasswordDraft,
    handleConfirmName,
    handleConfirmPassword,
    handleLeave,
  };
}
