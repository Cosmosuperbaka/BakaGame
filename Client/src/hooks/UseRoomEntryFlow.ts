import { useEffect, useEffectEvent, useRef, useState } from "react";
import { isValidRoomId } from "@bakagame/shared/values";
import type { RoomPasswordError } from "@/components/common/room/RoomPasswordField";
import { usePageNavigate } from "@/hooks/UsePageTransition";
import { errorCode, errorText } from "@/lib/ErrorMessage";
import { getSavedUsername, saveUsername } from "@/lib/Storage";

/** 入房流程从玩法 store 订阅的三项状态。 */
export interface RoomEntryState {
  /** store 已经在这间房里（房号与快照都对得上）：页面直接展示房间，不再走入房。 */
  alreadyIn: boolean;
  /** store 还挂着房间（快照或房号任一仍在）。 */
  attached: boolean;
  /** 最近一次房间被关或席位被替代的时刻。 */
  closedAt: number | null;
}

/**
 * 一款玩法接入入房流程所需的 store 能力。除 `useRoomState` 外都在调用时读 store，
 * 适配器因此可以是模块级常量。
 */
export interface RoomEntryAdapter {
  /** 在渲染里订阅入房流程关心的 store 状态。 */
  useRoomState: (roomId: string) => RoomEntryState;
  /** 等连接可用；超时以拒绝告知。 */
  waitReady: () => Promise<void>;
  reconnect: (roomId: string, signal: AbortSignal) => Promise<boolean>;
  join: (
    roomId: string,
    name: string,
    password: string | undefined,
    signal: AbortSignal
  ) => Promise<void>;
  /** 房号不存在时就地以该名字开一间。 */
  createMissing: (roomId: string, name: string, signal: AbortSignal) => Promise<void>;
  roomClosedAt: () => number | null;
  clearRoomClosed: () => void;
  leave: () => Promise<void>;
  showError: (text: string) => void;
  /**
   * 单人房：不问名字也不加入，直接以这个房号建一间；返回最终房号（撞号时会换号）。
   * 有它时入房流程不走名字、密码与就地建房。
   */
  enterSolo?: (roomId: string, signal: AbortSignal) => Promise<string>;
  /** 房间被关或主动离开时忘掉本机记着的房号（单人房下次进来另开一间）。 */
  forgetRoom?: () => void;
}

/** 三款之间本质或尚未拍板的差异，逐款取现状，不在入房流程里统一。 */
export interface RoomEntryPolicy {
  /** 直链进房而本机没存过名字：弹名字框让玩家填。 */
  missingName: "prompt";
  /** 归密码步处理的加入失败码（缺密码、密码错误、尝试过多）；不在其中的拒绝提示后回大厅。 */
  passwordCodes: ReadonlySet<string>;
  /** 主动离开时先换页，房间页卸载时退房。 */
  leaveOn: "unmount";
  /** 失败、主动离开与脱离房间回大厅时是否替换历史；无效房号与房间被关一律替换。 */
  replaceOnExit: boolean;
  /** 不在入房、名字与密码步，而 store 已不挂任何房间时自行回大厅。 */
  exitWhenDetached: boolean;
  /** 「房间被关」的检查排在入房 effect 之前还是之后。 */
  closeCheck: "beforeEntry" | "afterEntry";
  /** 主动离开之后才收到的房间被关：照常替换回大厅，还是不再理会。 */
  closeAfterLeave: "exit" | "ignore";
}

const CONNECT_TIMEOUT_TEXT = "连接服务器超时，请刷新重试";

/**
 * 密码步框下写的原因。不带密码的首次加入被拒只是「这间房要密码」，不算失败、不写原因
 * （猜歌服务端此时回的是密码错误码，同样不能标红）；尝试过多不论带没带密码都要说明。
 * 只有密码本身不对才标红输入框，文案取服务端应答，与大厅的密码弹窗同一口径。
 */
function passwordStepError(
  error: unknown,
  code: string,
  password: string | undefined
): RoomPasswordError | null {
  if (password === undefined && code !== "TOO_MANY_ATTEMPTS") return null;
  return {
    message: errorText(error, "加入房间失败，请重试"),
    invalid: code === "PASSWORD_INCORRECT",
  };
}

/**
 * 直链进房的状态机：等连接、恢复上次的座位、问名字、问密码、房号不存在就地建房、
 * 房间被关时退回、主动离开时先换页再退房。入房事务归属路由房号：只在房号变化或卸载时作废，
 * 快照与 ACK 的更新不能取消已经接入的会话；作废后到的 ACK 由 store 的入房事务精确释放。
 */
export function useRoomEntryFlow({
  roomId,
  exitPath,
  adapter,
  policy,
  onRoomSwitched,
}: {
  roomId: string;
  exitPath: string;
  adapter: RoomEntryAdapter;
  policy: RoomEntryPolicy;
  /** 单人房撞号换号后、ACK 落定时告知最终房号；房号随之变化不会取消这次入房。 */
  onRoomSwitched?: (roomId: string) => void;
}) {
  const navigate = usePageNavigate();
  const { alreadyIn, attached, closedAt } = adapter.useRoomState(roomId);

  const [joining, setJoining] = useState(!alreadyIn);
  // 从分享链接直接进房、本地又没存过名字时，先问名字再进房，而不是踢回大厅。
  const [needsName, setNeedsName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  // 私密房：不带密码的加入被拒后先问密码；名字沿用已确认的那个
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [pendingJoinName, setPendingJoinName] = useState("");
  const [passwordError, setPasswordError] = useState<RoomPasswordError | null>(null);
  // 同一次渲染里连点两下时状态还没更新，靠它挡住第二次提交。
  const passwordInFlight = useRef(false);
  // 只认本次挂载之后发生的关闭：更早的标记是上一次房间留下的，不能弹走再次进入的玩家。
  const [mountTime] = useState(() => Date.now());
  const entryRef = useRef<AbortController | null>(null);
  const leavingRef = useRef(false);

  const exit = (replace = policy.replaceOnExit) => {
    if (replace) void navigate(exitPath, { replace: true });
    else void navigate(exitPath);
  };

  // 挂载与卸载时清理残留的关闭标记
  useEffect(() => {
    adapter.clearRoomClosed();
    return () => {
      adapter.clearRoomClosed();
    };
  }, [adapter]);

  // 房间被服务端关闭或席位被替换：这是一个明确的事件，无论当前是否正在加入
  // 都必须立刻退回大厅，否则加入流程中被关闭会一直停在加载态。
  const onClosed = useEffectEvent(() => {
    if (policy.closeAfterLeave === "ignore" && leavingRef.current) return;
    entryRef.current?.abort();
    adapter.clearRoomClosed();
    adapter.forgetRoom?.();
    exit(true);
  });
  const closeCheck = policy.closeCheck;
  useEffect(() => {
    if (closeCheck === "beforeEntry" && closedAt && closedAt >= mountTime) onClosed();
  }, [closeCheck, mountTime, closedAt]);

  // 主动离开等其它原因导致的脱离房间。等用户填名字或密码的这段时间同样没有房间，
  // 但那是正常状态，不能当成房间已关闭。
  const onDetached = useEffectEvent(() => exit());
  useEffect(() => {
    if (policy.exitWhenDetached && !joining && !needsName && !needsPassword && !attached)
      onDetached();
  }, [policy.exitWhenDetached, joining, needsName, needsPassword, attached]);

  /** 进房成功：离开名字与密码步，展示房间。 */
  const entered = () => {
    setNeedsPassword(false);
    setJoining(false);
  };
  /** 无法就地解决的失败：先撤下密码步（确认在途时它还开着），再提示回大厅。 */
  const failAndExit = (text: string) => {
    setNeedsPassword(false);
    adapter.showError(text);
    exit();
  };

  /** 用给定名字加入房间；房间不存在就以该名字开一间。 */
  const enterWithName = async (name: string, signal: AbortSignal, password?: string) => {
    if (!roomId || signal.aborted) return;
    setJoining(true);
    try {
      await adapter.join(roomId, name, password, signal);
      if (!signal.aborted) entered();
    } catch (error) {
      if (signal.aborted) return;
      const code = errorCode(error);
      if (code !== undefined && policy.passwordCodes.has(code)) {
        // 缺密码、密码错误与尝试过多都留在密码框，原因写在框下，而不是踢回大厅
        setPendingJoinName(name);
        setPasswordDraft("");
        setPasswordError(passwordStepError(error, code, password));
        setNeedsPassword(true);
        setJoining(false);
      } else if (code === "ROOM_NOT_FOUND") {
        try {
          await adapter.createMissing(roomId, name, signal);
          if (!signal.aborted) entered();
        } catch (createError) {
          if (!signal.aborted) failAndExit(errorText(createError, "创建房间失败"));
        }
      } else {
        failAndExit(errorText(error, "加入房间失败"));
      }
    }
  };

  const enterSolo = async (
    create: NonNullable<RoomEntryAdapter["enterSolo"]>,
    signal: AbortSignal
  ) => {
    let finalRoomId: string;
    try {
      finalRoomId = await create(roomId, signal);
    } catch (error) {
      if (signal.aborted) return;
      adapter.showError(errorText(error, "创建单人房间失败"));
      exit();
      return;
    }
    if (signal.aborted) return;
    // ACK 落定后才切换房号，避免房号变化的清理取消本次重试。
    if (finalRoomId !== roomId) onRoomSwitched?.(finalRoomId);
    setJoining(false);
  };

  /** 连上之后的入房：先恢复上次的座位，恢复不了再按名字加入。 */
  const enterWhenReady = async (signal: AbortSignal) => {
    // 首次挂载时 joining 本就为真；同一页面换到另一间房时旧快照的房号对不上，进房界面照样显示加载态，
    // 因此连上之后再置位即可，不必在 effect 里同步改状态。
    setJoining(true);
    let restored: boolean;
    try {
      restored = await adapter.reconnect(roomId, signal);
    } catch (error) {
      if (signal.aborted) return;
      // 临时恢复失败不是「没有可恢复会话」，不能继续自动加入或创建。
      adapter.showError(errorText(error, "恢复房间失败，请重试"));
      exit();
      return;
    }
    if (signal.aborted) return;
    if (restored) {
      setJoining(false);
      return;
    }
    // 恢复被永久拒绝且房间已不在：由关闭分支退回大厅，这里不能再按房号开一间。
    const closed = adapter.roomClosedAt();
    if (closed !== null && closed >= mountTime) return;
    if (adapter.enterSolo) {
      await enterSolo(adapter.enterSolo, signal);
      return;
    }

    const name = getSavedUsername();
    if (!name) {
      setJoining(false);
      setNameDraft("");
      setNeedsName(true);
      return;
    }
    await enterWithName(name, signal);
  };

  const begin = useEffectEvent((signal: AbortSignal) => {
    if (!roomId || alreadyIn) return;
    if (!isValidRoomId(roomId)) {
      adapter.showError("房间号无效，请检查链接");
      exit(true);
      return;
    }
    adapter.clearRoomClosed();
    adapter.waitReady().then(
      () => {
        if (!signal.aborted) void enterWhenReady(signal);
      },
      () => {
        if (signal.aborted) return;
        adapter.showError(CONNECT_TIMEOUT_TEXT);
        exit();
      }
    );
  });
  // 入房事务归属路由房号，而非快照；取消后的 ACK 释放由 store 负责。
  useEffect(() => {
    const entry = new AbortController();
    entryRef.current = entry;
    leavingRef.current = false;
    begin(entry.signal);
    return () => {
      entry.abort();
      if (entryRef.current === entry) entryRef.current = null;
    };
  }, [roomId]);
  useEffect(() => {
    if (closeCheck === "afterEntry" && closedAt && closedAt >= mountTime) onClosed();
  }, [closeCheck, mountTime, closedAt]);

  const confirmName = async () => {
    const name = nameDraft.trim();
    if (!name) {
      adapter.showError("请输入用户名");
      return;
    }
    saveUsername(name);
    setNeedsName(false);
    const signal = entryRef.current?.signal;
    if (!signal || signal.aborted) return;
    await enterWithName(name, signal);
  };

  // 确认在途时密码框留着、确认钮转圈（joining 为真），上一次的原因先撤下，新的结果到了再写。
  const confirmPassword = async () => {
    if (!pendingJoinName || !passwordDraft.trim() || passwordInFlight.current) return;
    const signal = entryRef.current?.signal;
    if (!signal || signal.aborted) return;
    passwordInFlight.current = true;
    setPasswordError(null);
    try {
      await enterWithName(pendingJoinName, signal, passwordDraft);
    } finally {
      passwordInFlight.current = false;
    }
  };

  // 先换页、页面卸载后再退房：退房会清空快照，若先退再走，跨页过渡拍下的旧页就成了加入中的转圈，
  // 清空还会触发上面「脱离房间」的回退再导航一次，打断进行中的过渡（DesignGuide §8）。
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (!exiting) return;
    return () => void adapter.leave();
  }, [adapter, exiting]);
  const leave = () => {
    entryRef.current?.abort();
    leavingRef.current = true;
    adapter.forgetRoom?.();
    setExiting(true);
    exit();
  };

  return {
    joining,
    needsName,
    nameDraft,
    setNameDraft,
    confirmName,
    needsPassword,
    passwordDraft,
    setPasswordDraft,
    passwordError,
    confirmPassword,
    leave,
  };
}
