import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { getSongSoloRoomId, getSonGuessrSessionToken, saveSongSoloRoomId, saveSonGuessrSessionToken, saveUsername } from "@/lib/Storage";
import { songSnapshot, songPrivate } from "@/stories/fixtures/SonGuessr";
import { useSongRoomLifecycle } from "./UseSongRoomLifecycle";

const { navigate, waitConnection, send, randomId } = vi.hoisted(() => ({
  navigate: vi.fn(), waitConnection: vi.fn(), send: vi.fn(), randomId: vi.fn(),
}));
vi.mock("@/hooks/UsePageTransition", () => ({ usePageNavigate: () => navigate }));
vi.mock("@/lib/SonGuessrWs", () => ({ sonGuessrWs: { waitForConnection: waitConnection, send } }));
vi.mock("@/lib/Random", () => ({ randomRoomId: randomId }));
const initial = useSonGuessrStore.getState();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const receipt = (roomId = "1234") => ({ roomId, sessionToken: "fixture-token", snapshot: songSnapshot({ roomId }), privateState: songPrivate({ sessionToken: "fixture-token" }) });
function mount(solo = false, strict = false) {
  const wrapper = ({ children }: { children: ReactNode }) => {
    const router = <MemoryRouter initialEntries={["/songuessr/room/1234"]}><Routes><Route path="/songuessr/room/:roomId" element={children} /></Routes></MemoryRouter>;
    return strict ? <StrictMode>{router}</StrictMode> : router;
  };
  return renderHook(() => useSongRoomLifecycle({ solo }), { wrapper });
}
beforeEach(() => {
  vi.resetAllMocks();
  useSonGuessrStore.setState({ ...initial, connected: true, setNotice: vi.fn() }, true);
  waitConnection.mockResolvedValue(undefined);
  randomId.mockReturnValue("5678");
  send.mockImplementation(async (type: string, payload: Record<string, unknown> = {}, metadata: { roomId?: string } = {}) => {
    if (type === "song.room.leave") return undefined;
    if (!["song.room.join", "song.room.create", "song.room.reconnect"].includes(type)) throw new Error(`测试禁止命令 ${type}`);
    return receipt(String(metadata.roomId ?? payload.roomId ?? "1234"));
  });
  saveUsername("玩家");
});
afterEach(() => useSonGuessrStore.setState(initial, true));

describe("猜歌直链 caller 取消归属（真实 hook / Store，deferred WS）", () => {
  it("等连接期间卸载不发恢复或加入", async () => {
    const connection = deferred<void>(); waitConnection.mockReturnValue(connection.promise);
    const h = mount(); h.unmount();
    await act(async () => connection.resolve());
    expect(send).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });
  it("加入 ACK 在卸载后只释放席位，不落会话或导航", async () => {
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockImplementation((type: string) => type === "song.room.join" ? ack.promise : Promise.resolve());
    const h = mount(); await waitFor(() => expect(send).toHaveBeenCalledWith("song.room.join", expect.anything(), expect.anything()));
    h.unmount(); await act(async () => ack.resolve(receipt()));
    await waitFor(() => expect(send).toHaveBeenCalledWith("song.room.leave", {}, { roomId: "1234", sessionToken: "fixture-token" }));
    expect(useSonGuessrStore.getState().roomId).toBeNull(); expect(getSonGuessrSessionToken("1234")).toBeNull(); expect(navigate).not.toHaveBeenCalled();
  });
  it("离开后 ROOM_NOT_FOUND 不再创建", async () => {
    const ack = deferred<ReturnType<typeof receipt>>(); send.mockReturnValue(ack.promise);
    const h = mount(); await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    act(() => h.result.current.leave());
    await act(async () => ack.reject({ code: "ROOM_NOT_FOUND" }));
    expect(send).toHaveBeenCalledTimes(1); expect(navigate).toHaveBeenCalledExactlyOnceWith("/songuessr", { replace: true });
  });
  it("ROOM_NOT_FOUND 创建使用同一 signal，晚 ACK 由 Store 释放", async () => {
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockImplementation((type: string) => type === "song.room.join" ? Promise.reject({ code: "ROOM_NOT_FOUND" }) : type === "song.room.create" ? ack.promise : Promise.resolve());
    const join = vi.fn(initial.joinRoom); const create = vi.fn(initial.createRoom);
    useSonGuessrStore.setState({ joinRoom: join, createRoom: create });
    const h = mount(); await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const signal = join.mock.calls[0][3]; expect(signal).toBeInstanceOf(AbortSignal); expect(create.mock.calls[0][1]).toBe(signal);
    h.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => ack.resolve(receipt()));
    expect(useSonGuessrStore.getState().roomId).toBeNull(); expect(navigate).not.toHaveBeenCalled();
  });
  it("临时恢复错误不退化成加入或单人自动创建", async () => {
    saveSonGuessrSessionToken("1234", "saved-token"); saveSongSoloRoomId("1234");
    send.mockRejectedValue({ code: "DISCONNECTED", message: "恢复暂时断开" });
    const h = mount(true);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/", { replace: true }));
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0]).toBe("song.room.reconnect");
    expect(useSonGuessrStore.getState().setNotice).toHaveBeenCalledWith("恢复暂时断开", "error"); h.unmount();
  });
  it("StrictMode 恢复只发一个请求，成功不自动加入", async () => {
    saveSonGuessrSessionToken("1234", "saved-token");
    const ack = deferred<ReturnType<typeof receipt>>(); send.mockReturnValue(ack.promise);
    const h = mount(false, true); await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await act(async () => ack.resolve(receipt()));
    expect(h.result.current.joining).toBe(false); expect(send).toHaveBeenCalledTimes(1);
    expect(getSonGuessrSessionToken("1234")).toBe("fixture-token");
  });
  it("旧挂载取消，新 signal 接管同一在途 Store 恢复而不释放成功席位", async () => {
    saveSonGuessrSessionToken("1234", "saved-token");
    const ack = deferred<ReturnType<typeof receipt>>(); send.mockReturnValue(ack.promise);
    const reconnect = vi.fn(initial.reconnectRoom); useSonGuessrStore.setState({ reconnectRoom: reconnect });
    const first = mount(); await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1)); first.unmount();
    const second = mount(); await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(2));
    const oldSignal = reconnect.mock.calls[0][1]; const newSignal = reconnect.mock.calls[1][1];
    expect(oldSignal?.aborted).toBe(true); expect(newSignal?.aborted).toBe(false); expect(newSignal).not.toBe(oldSignal);
    await act(async () => ack.resolve(receipt()));
    expect(second.result.current.joining).toBe(false); expect(send).toHaveBeenCalledTimes(1); expect(useSonGuessrStore.getState().roomId).toBe("1234");
  });
  it("单人 ROOM_EXISTS 重试在 ACK 前不换 roomId 或取消自身", async () => {
    saveSongSoloRoomId("1234"); const ack = deferred<ReturnType<typeof receipt>>();
    send.mockImplementation((_type: string, payload: { roomId: string }) => payload.roomId === "1234" ? Promise.reject({ code: "ROOM_EXISTS" }) : ack.promise);
    const create = vi.fn(initial.createRoom); useSonGuessrStore.setState({ createRoom: create });
    const h = mount(true); await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(h.result.current.roomId).toBe("1234"); const signal = create.mock.calls[0][1]; expect(create.mock.calls[1][1]).toBe(signal); expect(signal?.aborted).toBe(false);
    await act(async () => ack.resolve(receipt("5678")));
    expect(h.result.current.roomId).toBe("5678"); expect(h.result.current.joining).toBe(false); expect(getSongSoloRoomId()).toBe("5678");
    expect(send).toHaveBeenCalledTimes(2); expect(useSonGuessrStore.getState().roomId).toBe("5678");
  });
  it("单人重试晚 ACK 不保存 solo 房号或导航", async () => {
    saveSongSoloRoomId("1234"); const ack = deferred<ReturnType<typeof receipt>>();
    send.mockImplementation((type: string, payload: { roomId?: string } = {}) => type === "song.room.leave" ? Promise.resolve() : payload.roomId === "1234" ? Promise.reject({ code: "ROOM_EXISTS" }) : ack.promise);
    const h = mount(true); await waitFor(() => expect(send).toHaveBeenCalledTimes(2)); h.unmount(); await act(async () => ack.resolve(receipt("5678")));
    expect(getSongSoloRoomId()).toBe("1234"); expect(useSonGuessrStore.getState().roomId).toBeNull(); expect(navigate).not.toHaveBeenCalled();
  });
  it("用户补名字与密码时仍传入当前归属 signal", async () => {
    window.localStorage.clear(); send.mockRejectedValueOnce({ code: "PASSWORD_REQUIRED" });
    const join = vi.fn(initial.joinRoom); useSonGuessrStore.setState({ joinRoom: join });
    const h = mount(); await waitFor(() => expect(h.result.current.needsName).toBe(true));
    act(() => h.result.current.setNameDraft("新玩家")); await act(async () => h.result.current.handleConfirmName());
    expect(h.result.current.needsPassword).toBe(true);
    act(() => h.result.current.setPasswordDraft("fixture-password")); await act(async () => h.result.current.handleConfirmPassword());
    expect(join.mock.calls[0]).toEqual(["1234", "新玩家", undefined, expect.any(AbortSignal)]);
    expect(join.mock.calls[1]).toEqual(["1234", "新玩家", "fixture-password", join.mock.calls[0][3]]);
    expect(h.result.current.joining).toBe(false);
  });
});
