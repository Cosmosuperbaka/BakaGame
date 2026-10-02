import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { getSavedUsername, saveUsername } from "@/lib/Storage";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";

/**
 * 房间路由只带统一房号：来源（增强房 / 原版房）由服务端的房号目录判定，
 * 进入成功后才从快照得知，加入表单不预先假设。
 */
export function useCCBRoomLifecycle() {
  const { roomId } = useParams();
  const navigate = usePageNavigate();
  const connected = useCCBStore((state) => state.connected);
  const lobbyReady = useCCBStore((state) => state.lobbyReady);
  const closed = useCCBStore((state) => state.roomClosedAt);
  const [joining, setJoining] = useState(true);
  const [needsJoin, setNeedsJoin] = useState(false);
  const [name, setName] = useState(getSavedUsername);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const attempted = useRef("");

  useEffect(() => {
    if (!roomId || closed) { navigate("/ccb", { replace: true }); return; }
    if (!connected || !lobbyReady) return;
    if (attempted.current === roomId) return;
    attempted.current = roomId;
    let cancelled = false;
    const restore = async () => {
      const store = useCCBStore.getState();
      if (store.roomId === roomId && store.snapshot) {
        setJoining(false); return;
      }
      try {
        const restored = await store.reconnectRoom(roomId);
        if (!cancelled) setNeedsJoin(!restored);
      } catch (failure) {
        if (!cancelled) { setError(ccbErrorMessage(failure)); setNeedsJoin(true); }
      } finally { if (!cancelled) setJoining(false); }
    };
    void restore();
    return () => { cancelled = true; attempted.current = ""; };
  }, [roomId, connected, lobbyReady, closed, navigate]);

  const join = async () => {
    if (!roomId || !name.trim() || joining) return;
    setJoining(true); setError("");
    try {
      await useCCBStore.getState().joinRoom(roomId, name.trim(), password);
      saveUsername(name.trim()); setNeedsJoin(false);
    } catch (failure) { setError(ccbErrorMessage(failure)); }
    finally { setJoining(false); }
  };
  // 只换页：大厅挂载时发现仍留着房间，会先退房再订阅大厅（CCBPage），失败提示也在那里。
  // 先退再走的话，跨页过渡拍下的旧页就成了清空快照后的「请加入房间」（Animation §2.4）。
  const leave = useCallback(() => {
    navigate("/ccb");
  }, [navigate]);

  return { roomId, connected, joining, needsJoin, name, setName, password, setPassword, error, join, leave };
}
