import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { TEST_ROOM_ID } from "@/config/Constants";
import { getSavedUsername, guestName, saveUsername } from "@/lib/Storage";
import { normalizeCEERoomId } from "@/lib/CEESession";
import { ceeErrorMessage, useCEEStore } from "@/stores/UseCEEStore";
import { isProtocolError } from "@/lib/WebsocketClient";

/**
 * 房间路由只带统一房号：来源（增强房 / 原版房）由服务端的房号目录判定，
 * 进入成功后才从快照得知，加入表单不预先假设。
 */
export function useCEERoomLifecycle() {
  const { roomId: routeRoomId } = useParams();
  const roomId = routeRoomId ? normalizeCEERoomId(routeRoomId) : undefined;
  const navigate = usePageNavigate();
  const connected = useCEEStore((state) => state.connected);
  const lobbyReady = useCEEStore((state) => state.lobbyReady);
  const closed = useCEEStore((state) => state.roomClosedAt);
  const [joining, setJoining] = useState(true);
  const [needsJoin, setNeedsJoin] = useState(false);
  const [name, setName] = useState(getSavedUsername);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  // 服务端的错误码：是否进入密码步、密码框是否标红按它判断，不匹配文案。
  const [errorCode, setErrorCode] = useState("");
  const fail = (failure: unknown) => { setError(ceeErrorMessage(failure)); setErrorCode(isProtocolError(failure) ? failure.code : ""); };
  const attempted = useRef("");
  const manualJoin = useRef<AbortController | null>(null);
  useEffect(() => () => { manualJoin.current?.abort(); }, [roomId]);

  /**
   * 直链进入：房号未命中（服务重启后房间随内存清空、测试房、已关闭房间的分享链接）时，
   * 用同一房号就地开一间增强房再进入，与另外两个游戏的直链行为一致。
   * 密码错误、重名等其它业务拒绝保持原样报错，不触发建房。
   */
  const joinOrCreate = async (targetRoomId: string, userName: string, passwordDraft: string, controller: AbortController) => {
    try {
      await useCEEStore.getState().joinRoom(targetRoomId, userName, passwordDraft, controller.signal);
    } catch (failure) {
      if (!isProtocolError(failure) || failure.code !== "ROOM_NOT_FOUND") throw failure;
      await useCEEStore.getState().createRoom({
        source: "native",
        roomId: targetRoomId,
        // 房间名协议上限 32：用户名最多 32 字符，「的房间」后缀要留出空间。
        name: targetRoomId === TEST_ROOM_ID ? "CEE 测试房" : `${userName.slice(0, 29)}的房间`,
        userName,
        visibility: "public",
        allowSpectators: true,
      }, controller.signal);
    }
  };

  /**
   * 直链自动进房：没存过名字就用访客名，与另外两个游戏一致，不弹设置用户名。
   * 密码错误、房间已满等业务拒绝在此报出，页面按错误码决定是否转入密码步。
   */
  const autoJoin = async (targetRoomId: string, controller: AbortController) => {
    const userName = name.trim() || guestName();
    try {
      await joinOrCreate(targetRoomId, userName, "", controller);
      if (controller.signal.aborted) return;
      saveUsername(userName); setName(userName); setNeedsJoin(false);
    } catch (failure) { if (!controller.signal.aborted) fail(failure); }
  };

  useEffect(() => {
    if (!roomId || closed) { void navigate("/cee", { replace: true }); return; }
    if (!connected || !lobbyReady) return;
    if (attempted.current === roomId) return;
    attempted.current = roomId;
    const controller = new AbortController();
    const restore = async () => {
      const store = useCEEStore.getState();
      if (store.roomId === roomId && store.snapshot) {
        setJoining(false); return;
      }
      try {
        const restored = await store.reconnectRoom(roomId, controller.signal);
        if (controller.signal.aborted) return;
        if (!restored) await autoJoin(roomId, controller);
      } catch (failure) {
        if (!controller.signal.aborted) { fail(failure); setNeedsJoin(true); }
      } finally { if (!controller.signal.aborted) setJoining(false); }
    };
    void restore();
    return () => { controller.abort(); attempted.current = ""; };
  }, [roomId, connected, lobbyReady, closed, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 手动确认（密码步提交）：用表单里的名字与密码重试。 */
  const join = async () => {
    if (!roomId || !name.trim() || joining || manualJoin.current) return;
    const controller = new AbortController();
    manualJoin.current = controller;
    setJoining(true); setError(""); setErrorCode("");
    try {
      await joinOrCreate(roomId, name.trim(), password, controller);
      if (controller.signal.aborted) return;
      saveUsername(name.trim()); setNeedsJoin(false);
    } catch (failure) { if (!controller.signal.aborted) fail(failure); }
    finally {
      if (manualJoin.current === controller) manualJoin.current = null;
      if (!controller.signal.aborted) setJoining(false);
    }
  };
  // 只换页：大厅挂载时发现仍留着房间，会先退房再订阅大厅（CEEPage），失败提示也在那里。
  // 先退再走的话，跨页过渡拍下的旧页就成了清空快照后的「请加入房间」（Animation §2.4）。
  const leave = useCallback(() => {
    void navigate("/cee");
  }, [navigate]);

  return { roomId, connected, joining, needsJoin, name, setName, password, setPassword, error, errorCode, join, leave };
}
