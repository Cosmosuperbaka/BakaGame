import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SonGuessrMusicPoolView, SonGuessrRoomSnapshot } from "@bakagame/shared";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import {
  getSongSoloRoomId,
  getSonGuessrSessionToken,
  saveSongSoloRoomId,
  saveSonGuessrSessionToken,
  saveUsername,
} from "@/lib/Storage";
import { getStoredSongMusicSession, saveSongMusicSession } from "@/lib/SonGuessrMusicSession";
import { SONG_ACCOUNTS, songSnapshot, songPrivate } from "@/stories/fixtures/SonGuessr";
import { useSongRoomLifecycle } from "./UseSongRoomLifecycle";
import { rejectedProtocol } from "@/lib/ProtocolFailure";

const { navigate, waitConnection, send, randomId } = vi.hoisted(() => ({
  navigate: vi.fn(),
  waitConnection: vi.fn(),
  send: vi.fn(),
  randomId: vi.fn(),
}));
vi.mock("@/hooks/UsePageTransition", () => ({ usePageNavigate: () => navigate }));
vi.mock("@/lib/SonGuessrWs", () => ({ waitForConnection: waitConnection, send }));
vi.mock("@/lib/Random", () => ({ randomRoomId: randomId }));
const initial = useSonGuessrStore.getState();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const receipt = (roomId = "1234") => ({
  roomId,
  sessionToken: "fixture-token",
  snapshot: songSnapshot({ roomId }),
  privateState: songPrivate({ sessionToken: "fixture-token" }),
});
function mount(solo = false, strict = false) {
  const wrapper = ({ children }: { children: ReactNode }) => {
    const router = (
      <MemoryRouter initialEntries={["/songuessr/room/1234"]}>
        <Routes>
          <Route path="/songuessr/room/:roomId" element={children} />
        </Routes>
      </MemoryRouter>
    );
    return strict ? <StrictMode>{router}</StrictMode> : router;
  };
  return renderHook(() => useSongRoomLifecycle({ solo }), { wrapper });
}
beforeEach(() => {
  vi.resetAllMocks();
  useSonGuessrStore.setState({ ...initial, connected: true, showToast: vi.fn() }, true);
  waitConnection.mockResolvedValue(undefined);
  randomId.mockReturnValue("5678");
  send.mockImplementation(
    async (
      type: string,
      payload: Record<string, unknown> = {},
      metadata: { roomId?: string } = {}
    ) => {
      if (type === "song.room.leave") return undefined;
      if (!["song.room.join", "song.room.create", "song.room.reconnect"].includes(type))
        throw new Error(`测试禁止命令 ${type}`);
      const roomId = [metadata.roomId, payload.roomId].find(
        (value): value is string => typeof value === "string"
      );
      return receipt(roomId ?? "1234");
    }
  );
  saveUsername("玩家");
});
afterEach(() => useSonGuessrStore.setState(initial, true));

describe("猜歌直链 caller 取消归属（真实 hook / Store，deferred WS）", () => {
  it("等连接期间卸载不发恢复或加入", async () => {
    const connection = deferred<void>();
    waitConnection.mockReturnValue(connection.promise);
    const h = mount();
    h.unmount();
    await act(async () => connection.resolve());
    expect(send).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("加入 ACK 在卸载后只释放席位，不落会话或导航", async () => {
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockImplementation((type: string) =>
      type === "song.room.join" ? ack.promise : Promise.resolve()
    );
    const h = mount();
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("song.room.join", expect.anything(), expect.anything())
    );
    h.unmount();
    await act(async () => ack.resolve(receipt()));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "song.room.leave",
        {},
        { roomId: "1234", sessionToken: "fixture-token" }
      )
    );
    expect(useSonGuessrStore.getState().roomId).toBeNull();
    expect(getSonGuessrSessionToken("1234")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("离开后 ROOM_NOT_FOUND 不再创建", async () => {
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockReturnValue(ack.promise);
    const h = mount();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    act(() => h.result.current.leave());
    await act(async () => ack.reject({ code: "ROOM_NOT_FOUND" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/songuessr", { replace: true });
  });
  it("ROOM_NOT_FOUND 创建使用同一 signal，晚 ACK 由 Store 释放", async () => {
    const ack = deferred<ReturnType<typeof receipt>>();
    // 夹具复刻服务端 error 包的形状：被测代码读的是 code，不是 Error。
    send.mockImplementation((type: string) =>
      type === "song.room.join"
        ? rejectedProtocol({ code: "ROOM_NOT_FOUND", message: "房间不存在" })
        : type === "song.room.create"
          ? ack.promise
          : Promise.resolve()
    );
    const join = vi.fn(initial.joinRoom);
    const create = vi.fn(initial.createRoom);
    useSonGuessrStore.setState({ joinRoom: join, createRoom: create });
    const h = mount();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const signal = join.mock.calls[0][3];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(create.mock.calls[0][1]).toBe(signal);
    h.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => ack.resolve(receipt()));
    expect(useSonGuessrStore.getState().roomId).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("临时恢复错误不退化成加入或单人自动创建", async () => {
    saveSonGuessrSessionToken("1234", "saved-token");
    saveSongSoloRoomId("1234");
    send.mockRejectedValue({ code: "DISCONNECTED", message: "恢复暂时断开" });
    const h = mount(true);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/", { replace: true }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("song.room.reconnect");
    expect(useSonGuessrStore.getState().showToast).toHaveBeenCalledWith("恢复暂时断开", "error");
    h.unmount();
  });
  it("StrictMode 恢复只发一个请求，成功不自动加入", async () => {
    saveSonGuessrSessionToken("1234", "saved-token");
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockReturnValue(ack.promise);
    const h = mount(false, true);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await act(async () => ack.resolve(receipt()));
    expect(h.result.current.joining).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getSonGuessrSessionToken("1234")).toBe("fixture-token");
  });
  it("旧挂载取消，新 signal 接管同一在途 Store 恢复而不释放成功席位", async () => {
    saveSonGuessrSessionToken("1234", "saved-token");
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockReturnValue(ack.promise);
    const reconnect = vi.fn(initial.reconnectRoom);
    useSonGuessrStore.setState({ reconnectRoom: reconnect });
    const first = mount();
    await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
    first.unmount();
    const second = mount();
    await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(2));
    const oldSignal = reconnect.mock.calls[0][1];
    const newSignal = reconnect.mock.calls[1][1];
    expect(oldSignal?.aborted).toBe(true);
    expect(newSignal?.aborted).toBe(false);
    expect(newSignal).not.toBe(oldSignal);
    await act(async () => ack.resolve(receipt()));
    expect(second.result.current.joining).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(useSonGuessrStore.getState().roomId).toBe("1234");
  });
  it("单人 ROOM_EXISTS 重试在 ACK 前不换 roomId 或取消自身", async () => {
    saveSongSoloRoomId("1234");
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockImplementation((_type: string, payload: { roomId: string }) =>
      payload.roomId === "1234"
        ? rejectedProtocol({ code: "ROOM_EXISTS", message: "房间号已被占用" })
        : ack.promise
    );
    const create = vi.fn(initial.createRoom);
    useSonGuessrStore.setState({ createRoom: create });
    const h = mount(true);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(h.result.current.roomId).toBe("1234");
    const signal = create.mock.calls[0][1];
    expect(create.mock.calls[1][1]).toBe(signal);
    expect(signal?.aborted).toBe(false);
    await act(async () => ack.resolve(receipt("5678")));
    expect(h.result.current.roomId).toBe("5678");
    expect(h.result.current.joining).toBe(false);
    expect(getSongSoloRoomId()).toBe("5678");
    expect(send).toHaveBeenCalledTimes(2);
    expect(useSonGuessrStore.getState().roomId).toBe("5678");
  });
  it("单人重试晚 ACK 不保存 solo 房号或导航", async () => {
    saveSongSoloRoomId("1234");
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockImplementation((type: string, payload: { roomId?: string } = {}) =>
      type === "song.room.leave"
        ? Promise.resolve()
        : payload.roomId === "1234"
          ? rejectedProtocol({ code: "ROOM_EXISTS", message: "房间号已被占用" })
          : ack.promise
    );
    const h = mount(true);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    h.unmount();
    await act(async () => ack.resolve(receipt("5678")));
    expect(getSongSoloRoomId()).toBe("1234");
    expect(useSonGuessrStore.getState().roomId).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("用户补名字与密码时仍传入当前归属 signal", async () => {
    window.localStorage.clear();
    send.mockRejectedValueOnce({ code: "PASSWORD_REQUIRED" });
    const join = vi.fn(initial.joinRoom);
    useSonGuessrStore.setState({ joinRoom: join });
    const h = mount();
    await waitFor(() => expect(h.result.current.needsName).toBe(true));
    act(() => h.result.current.setNameDraft("新玩家"));
    await act(async () => h.result.current.handleConfirmName());
    expect(h.result.current.needsPassword).toBe(true);
    act(() => h.result.current.setPasswordDraft("fixture-password"));
    await act(async () => h.result.current.handleConfirmPassword());
    expect(join.mock.calls[0]).toEqual(["1234", "新玩家", undefined, expect.any(AbortSignal)]);
    expect(join.mock.calls[1]).toEqual([
      "1234",
      "新玩家",
      "fixture-password",
      join.mock.calls[0][3],
    ]);
    expect(h.result.current.joining).toBe(false);
  });
});

describe("保存凭据的房间装载重试（真实 hook / 假定时器）", () => {
  const HOST_ID = "player-host";
  const GUEST_ID = "player-guest";
  const hostReceipt = (roomId = "1234") => ({
    roomId,
    sessionToken: "fixture-token",
    snapshot: songSnapshot({ roomId, hostPlayerId: HOST_ID }),
    privateState: songPrivate({ playerId: HOST_ID, sessionToken: "fixture-token" }),
  });
  /** 入房回包带上指定阶段与账号池，用于验证「只在这一阶段自动装载」与「池里已有我的号」两条分支。 */
  const receiptFor = (
    phase: SonGuessrRoomSnapshot["phase"],
    pool?: SonGuessrMusicPoolView[],
    playerId = HOST_ID
  ) => ({
    roomId: "1234",
    sessionToken: "fixture-token",
    snapshot: songSnapshot({ roomId: "1234", hostPlayerId: HOST_ID, phase, musicPool: pool }),
    privateState: songPrivate({ playerId, sessionToken: "fixture-token" }),
  });
  const myPoolEntry = (
    overrides: Partial<SonGuessrMusicPoolView> = {}
  ): SonGuessrMusicPoolView => ({
    playerId: HOST_ID,
    playerName: "夹具玩家",
    platform: "netease",
    account: SONG_ACCOUNTS.vip,
    enabled: true,
    inFlight: 0,
    recentOk: 0,
    recentTotal: 0,
    ...overrides,
  });
  const flush = async (ms = 0) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const uploadCalls = () => send.mock.calls.filter(([type]) => type === "song.auth.useCookie");

  beforeEach(() => {
    vi.useFakeTimers();
    saveSongMusicSession({ cookie: "MUSIC_U=fixture", account: SONG_ACCOUNTS.vip }, true);
  });
  afterEach(() => vi.useRealTimers());

  it("上游抖动会退避重试，落定后不再重复", async () => {
    let uploads = 0;
    send.mockImplementation(async (type: string) => {
      if (type === "song.room.join") return hostReceipt();
      if (type === "song.auth.useCookie") {
        uploads += 1;
        if (uploads === 1) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- 夹具抛出协议错误体：装载重试按 code 分支，包成 Error 会让用例走错路径
          throw { code: "MUSIC_API_RATE_LIMITED", message: "网易云接口触发限流退避" };
        }
        return { account: SONG_ACCOUNTS.vip };
      }
      return undefined;
    });

    const h = mount();
    await flush();
    expect(uploads).toBe(1);

    await flush(1_000);
    expect(uploads).toBe(2);
    expect(uploadCalls()).toHaveLength(2);

    // 成功后不再有任何后续装载，哪怕快照继续变化。
    await flush(30_000);
    expect(uploads).toBe(2);
    h.unmount();
  });

  it("会话失效清除本机凭据且不重试", async () => {
    let uploads = 0;
    send.mockImplementation(async (type: string) => {
      if (type === "song.room.join") return hostReceipt();
      if (type === "song.auth.useCookie") {
        uploads += 1;
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- 夹具抛出协议错误体：清凭据这类确定性失败按 code 判别
        throw { code: "MUSIC_SESSION_INVALID", message: "网易云登录状态已失效" };
      }
      return undefined;
    });

    const h = mount();
    await flush();
    expect(uploads).toBe(1);
    expect(getStoredSongMusicSession()).toBeNull();
    expect(useSonGuessrStore.getState().showToast).toHaveBeenCalledWith(
      "网易云登录状态已失效，请重新扫码登录",
      "error"
    );

    await flush(30_000);
    expect(uploads).toBe(1);
    h.unmount();
  });

  it("认证服务不可用这类确定性拒绝不重试，交给下一次快照变化", async () => {
    let uploads = 0;
    send.mockImplementation(async (type: string) => {
      if (type === "song.room.join") return hostReceipt();
      if (type === "song.auth.useCookie") {
        uploads += 1;
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- 夹具抛出协议错误体：不带 code 会被当成临时故障重试，这类拒绝必须留在不重试分支
        throw { code: "MUSIC_AUTH_UNAVAILABLE", message: "音乐认证服务暂时不可用" };
      }
      return undefined;
    });

    const h = mount();
    await flush();
    expect(uploads).toBe(1);
    // 不重试也不清本机凭据：认证服务的问题不是这份凭据的问题。
    expect(getStoredSongMusicSession()).not.toBeNull();

    await flush(30_000);
    expect(uploads).toBe(1);
    h.unmount();
  });

  it("同时保存双平台凭据时并行自动装载到房间", async () => {
    saveSongMusicSession(
      { cookie: "QQ_COOKIE=test", account: { ...SONG_ACCOUNTS.vip, platform: "qq" } },
      true,
      "qq"
    );
    const uploadedPlatforms: string[] = [];
    send.mockImplementation(async (type: string, payload?: Record<string, unknown>) => {
      if (type === "song.room.join") return hostReceipt();
      if (type === "song.auth.useCookie") {
        uploadedPlatforms.push(String(payload?.platform));
        return { account: SONG_ACCOUNTS.vip };
      }
      return undefined;
    });

    const h = mount();
    await flush();
    expect(uploadedPlatforms).toContain("netease");
    expect(uploadedPlatforms).toContain("qq");
    expect(uploadCalls()).toHaveLength(2);
    h.unmount();
  });

  it("局中入房不自动装载，回到准备页才把本机凭据传给房间", async () => {
    let uploads = 0;
    send.mockImplementation(async (type: string) => {
      if (type === "song.room.join") return receiptFor("playing");
      if (type === "song.auth.useCookie") {
        uploads += 1;
        return { account: SONG_ACCOUNTS.vip };
      }
      return undefined;
    });

    const h = mount();
    await flush();
    // 共享开关只在准备页可改：局中把本机凭据塞进池子，池里的开关状态就和实际生效的对不上。
    expect(uploads).toBe(0);

    act(() => {
      useSonGuessrStore.setState({ snapshot: receiptFor("waiting").snapshot });
    });
    await flush();
    expect(uploads).toBe(1);
    expect(uploadCalls()[0][1]).toEqual({ cookie: "MUSIC_U=fixture", platform: "netease" });
    h.unmount();
  });

  it("非房主也能贡献自己的号：池里没有我这条就自动装载", async () => {
    let uploads = 0;
    send.mockImplementation(async (type: string) => {
      if (type === "song.room.join") return receiptFor("waiting", [], GUEST_ID);
      if (type === "song.auth.useCookie") {
        uploads += 1;
        return { account: SONG_ACCOUNTS.vip };
      }
      return undefined;
    });

    const h = mount();
    await flush();
    expect(uploads).toBe(1);
    expect(uploadCalls()[0][1]).toEqual({ cookie: "MUSIC_U=fixture", platform: "netease" });
    h.unmount();
  });

  it("池里已有本人这份凭据时不再重传，换了账号才重新装载", async () => {
    let uploads = 0;
    send.mockImplementation(async (type: string) => {
      if (type === "song.room.join") return receiptFor("waiting", [myPoolEntry()]);
      if (type === "song.auth.useCookie") {
        uploads += 1;
        return { account: SONG_ACCOUNTS.vip };
      }
      return undefined;
    });

    const h = mount();
    await flush();
    // 同一份凭据已在服务端池里：重传只会多跑一次上游校验，还把「关掉共享」的开关又推给服务端一遍。
    expect(uploads).toBe(0);

    // 换了一个账号（池里我这条还是旧账号）才算新凭据，需要重新装载。
    act(() => {
      useSonGuessrStore.setState({
        snapshot: receiptFor("waiting", [myPoolEntry({ account: SONG_ACCOUNTS.nonVip })]).snapshot,
      });
    });
    await flush();
    expect(uploads).toBe(1);
    h.unmount();
  });
});
