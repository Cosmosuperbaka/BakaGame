import { StrictMode } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { getSessionToken, saveSessionToken, saveUsername } from "@/lib/Storage";
import { wifSnapshot, wifPrivate, WIF_PEOPLE } from "@/stories/fixtures/WhoIsFaker";
import WhoIsFakerRoomPage from "./WhoIsFakerRoomPage";

const { navigate, waitConnection, send } = vi.hoisted(() => ({ navigate: vi.fn(), waitConnection: vi.fn(), send: vi.fn() }));
vi.mock("@/hooks/UsePageTransition", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/UsePageTransition")>(), usePageNavigate: () => navigate,
}));
vi.mock("@/lib/WhoIsFakerWs", () => ({ waitForConnection: waitConnection, send }));
vi.mock("@/components/common/Seo", () => ({ Seo: () => null }));
vi.mock("@/components/common/ChatPanel", () => ({ ChatPanel: () => null }));
vi.mock("@/components/whoisfaker/layout/GameArea", () => ({ GameArea: () => null }));
vi.mock("@/components/whoisfaker/layout/PlayerList", () => ({ PLAYER_COLUMN_WIDTH: 200, PlayerList: () => null }));
vi.mock("@/components/whoisfaker/layout/AssignedWord", () => ({ AssignedWord: () => null }));
const initial = useWhoIsFakerStore.getState();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const receipt = () => ({ roomId: "1234", sessionToken: "fixture-token", snapshot: { ...wifSnapshot("waiting"), roomId: "1234" }, privateState: wifPrivate(WIF_PEOPLE.host, "waiting") });
function mount(strict = false) {
  const router = <MemoryRouter initialEntries={["/whoisfaker/room/1234"]}><Routes><Route path="/whoisfaker/room/:roomId" element={<WhoIsFakerRoomPage />} /></Routes></MemoryRouter>;
  return render(strict ? <StrictMode>{router}</StrictMode> : router);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  useWhoIsFakerStore.setState({ ...initial, connected: true, addToast: vi.fn() }, true);
  waitConnection.mockResolvedValue(undefined);
  send.mockImplementation(async (type: string) => {
    if (type === "room.leave") return undefined;
    if (!["room.join", "room.create", "room.reconnect"].includes(type)) throw new Error(`测试禁止命令 ${type}`);
    return receipt();
  });
  saveUsername("玩家");
});
afterEach(() => useWhoIsFakerStore.setState(initial, true));

describe("卧底直链入房归属（真实页面与Store，隔离WS）", () => {
  it("连接等待期间卸载不发入房或导航", async () => {
    const connection = deferred<void>(); waitConnection.mockReturnValue(connection.promise);
    const view = mount(); view.unmount(); await act(async () => connection.resolve());
    expect(send).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });
  it("卸载后的成功加入只释放精确席位，不保存会话", async () => {
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockImplementation((type: string) => type === "room.join" ? ack.promise : Promise.resolve());
    const view = mount(); await waitFor(() => expect(send).toHaveBeenCalledTimes(1)); view.unmount();
    await act(async () => ack.resolve(receipt()));
    expect(send.mock.calls[1]).toEqual(["room.leave", {}, { roomId: "1234", sessionToken: "fixture-token" }]);
    expect(useWhoIsFakerStore.getState().roomId).toBeNull(); expect(getSessionToken("1234")).toBeNull(); expect(navigate).not.toHaveBeenCalled();
  });
  it("卸载后房间不存在不接着创建，也不提示旧错误", async () => {
    const ack = deferred<ReturnType<typeof receipt>>(); send.mockReturnValue(ack.promise);
    const view = mount(); await waitFor(() => expect(send).toHaveBeenCalledTimes(1)); view.unmount();
    await act(async () => ack.reject({ code: "ROOM_NOT_FOUND" }));
    expect(send).toHaveBeenCalledTimes(1); expect(navigate).not.toHaveBeenCalled(); expect(useWhoIsFakerStore.getState().addToast).not.toHaveBeenCalled();
  });
  it("创建沿用加入signal，晚ACK释放席位", async () => {
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockImplementation((type: string) => type === "room.join" ? Promise.reject({ code: "ROOM_NOT_FOUND" }) : type === "room.create" ? ack.promise : Promise.resolve());
    const join = vi.fn(initial.joinRoom), create = vi.fn(initial.createRoom);
    useWhoIsFakerStore.setState({ joinRoom: join, createRoom: create });
    const view = mount(); await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][1]).toBe(join.mock.calls[0][3]); view.unmount();
    expect(join.mock.calls[0][3]?.aborted).toBe(true); await act(async () => ack.resolve(receipt()));
    expect(useWhoIsFakerStore.getState().roomId).toBeNull(); expect(navigate).not.toHaveBeenCalled();
  });
  it("StrictMode恢复共享单次请求，新effect接管不释放成功席位", async () => {
    saveSessionToken("1234", "saved-token"); const ack = deferred<ReturnType<typeof receipt>>(); send.mockReturnValue(ack.promise);
    const view = mount(true); await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith("room.reconnect", { roomId: "1234", sessionToken: "saved-token" }));
    await act(async () => ack.resolve(receipt()));
    expect(useWhoIsFakerStore.getState().roomId).toBe("1234"); expect(getSessionToken("1234")).toBe("fixture-token"); expect(send).toHaveBeenCalledTimes(1); expect(navigate).not.toHaveBeenCalled(); view.unmount();
  });
  it("临时恢复失败保留令牌并退出，不自动加入或创建", async () => {
    saveSessionToken("1234", "saved-token"); send.mockRejectedValue({ code: "DISCONNECTED", message: "暂时断开" });
    const view = mount(); await waitFor(() => expect(navigate).toHaveBeenCalledWith("/whoisfaker"));
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0]).toBe("room.reconnect"); expect(getSessionToken("1234")).toBe("saved-token"); view.unmount();
  });
  it("正常加入ACK保留身份不因快照更新取消，房间关闭才退出", async () => {
    const view = mount(); await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("1234"));
    expect(send).toHaveBeenCalledTimes(1); expect(navigate).not.toHaveBeenCalled();
    act(() => useWhoIsFakerStore.getState().markRoomClosed());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/whoisfaker", { replace: true })); view.unmount();
  });
});
