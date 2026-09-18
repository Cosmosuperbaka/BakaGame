import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { CCBSource } from "@bakagame/shared";
import { getSavedUsername, saveUsername } from "@/lib/Storage";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";

export function useCCBRoomLifecycle() {
  const { source: sourceParam, roomId } = useParams();
  const source: CCBSource | null = sourceParam === "native" || sourceParam === "original" ? sourceParam : null;
  const navigate = useNavigate();
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
    if (!source || !roomId || closed) { navigate("/ccb", { replace: true }); return; }
    if (!connected || !lobbyReady) return;
    const key = `${source}:${roomId}`;
    if (attempted.current === key) return;
    attempted.current = key;
    let cancelled = false;
    const restore = async () => {
      const store = useCCBStore.getState();
      if (store.source === source && store.roomId === roomId && store.snapshot) {
        setJoining(false); return;
      }
      try {
        const restored = await store.reconnectRoom(source, roomId);
        if (!cancelled) setNeedsJoin(!restored);
      } catch (failure) {
        if (!cancelled) { setError(ccbErrorMessage(failure)); setNeedsJoin(true); }
      } finally { if (!cancelled) setJoining(false); }
    };
    void restore();
    return () => { cancelled = true; attempted.current = ""; };
  }, [source, roomId, connected, lobbyReady, closed, navigate]);

  const join = async () => {
    if (!source || !roomId || !name.trim() || joining) return;
    setJoining(true); setError("");
    try {
      await useCCBStore.getState().joinRoom(source, roomId, name.trim(), password);
      saveUsername(name.trim()); setNeedsJoin(false);
    } catch (failure) { setError(ccbErrorMessage(failure)); }
    finally { setJoining(false); }
  };
  const leave = useCallback(async () => {
    try { await useCCBStore.getState().leaveRoom(); }
    catch (failure) { useCCBStore.getState().setNotice(ccbErrorMessage(failure)); }
    finally { navigate("/ccb"); }
  }, [navigate]);

  return { source, roomId, connected, joining, needsJoin, name, setName, password, setPassword, error, join, leave };
}
