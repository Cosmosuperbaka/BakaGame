import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@bakagame/shared";
import { rejectedProtocol } from "@/lib/ProtocolFailure";
import { getSongSoloRoomId, saveUsername } from "@/lib/Storage";
import { initSonGuessrWs, useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { songPrivate, songSnapshot } from "@/stories/fixtures/SonGuessr";
import SonGuessrRoomPage from "./SonGuessrRoomPage";

// 页面测试只关心入房的去向；真实排版与媒体演出由歌词浏览器回归覆盖。
vi.mock("@/components/songuessr/lyrics/SongLyricScene", () => ({
  SongLyricScene: class {
    setSource() {}
    setPlayback() {}
    dispose() {}
  },
}));

const { navigate, waitConnection, send, listeners } = vi.hoisted(() => ({
  navigate: vi.fn(),
  waitConnection: vi.fn(),
  send: vi.fn(),
  listeners: [] as Array<(message: ServerMessage) => void>,
}));
vi.mock("@/hooks/UsePageTransition", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/UsePageTransition")>()),
  usePageNavigate: () => navigate,
}));
vi.mock("@/lib/SonGuessrWs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/SonGuessrWs")>()),
  waitForConnection: waitConnection,
  send,
  connect: vi.fn(),
  disconnect: vi.fn(),
  onMessage: (fn: (message: ServerMessage) => void) => {
    listeners.push(fn);
    return () => {
      listeners.splice(listeners.indexOf(fn), 1);
    };
  },
  onStatus: () => () => {},
}));

const initial = useSonGuessrStore.getState();
const receipt = (roomId = "1234") => ({
  roomId,
  sessionToken: "fixture-token",
  snapshot: songSnapshot({ roomId }),
  privateState: songPrivate({ sessionToken: "fixture-token" }),
});
const types = () => send.mock.calls.map(([type]) => type);
const emit = (event: string, payload: unknown) =>
  listeners.forEach((handler) =>
    handler({ type: "event", event, payload } as unknown as ServerMessage)
  );

function mount(solo = false) {
  return render(
    <MemoryRouter initialEntries={[solo ? "/songuessr/solo" : "/songuessr/room/1234"]}>
      <Routes>
        <Route path="/songuessr/room/:roomId" element={<SonGuessrRoomPage />} />
        <Route path="/songuessr/solo" element={<SonGuessrRoomPage solo />} />
      </Routes>
    </MemoryRouter>
  );
}

let dispose: () => void = () => {};
beforeEach(() => {
  vi.resetAllMocks();
  listeners.length = 0;
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  useSonGuessrStore.setState({ ...initial, connected: true, showToast: vi.fn() }, true);
  dispose = initSonGuessrWs();
  waitConnection.mockResolvedValue(undefined);
  send.mockImplementation(async (type: string, payload: Record<string, unknown> = {}) => {
    if (type === "song.room.leave") return undefined;
    if (!["song.room.join", "song.room.create", "song.room.reconnect"].includes(type))
      return undefined;
    return receipt((payload.roomId as string | undefined) ?? "1234");
  });
  saveUsername("玩家");
});
afterEach(() => {
  dispose();
  useSonGuessrStore.setState(initial, true);
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("猜歌房间页的入房去向（真实页面与 Store，隔离 WS）", () => {
  it("名字框点返回大厅：替换回猜歌大厅，不发任何入房", async () => {
    window.localStorage.clear();
    const view = mount();
    await screen.findByLabelText("用户名");
    fireEvent.click(screen.getByRole("button", { name: "返回大厅" }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/songuessr", { replace: true });
    expect(send).not.toHaveBeenCalled();
    view.unmount();
    expect(send).not.toHaveBeenCalled();
  });
  it("密码框点返回大厅：替换回猜歌大厅，卸载时不退房", async () => {
    send.mockImplementation(async () =>
      rejectedProtocol({ code: "PASSWORD_REQUIRED", message: "需要房间密码" })
    );
    const view = mount();
    await screen.findByLabelText("房间密码");
    fireEvent.click(screen.getByRole("button", { name: "返回大厅" }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/songuessr", { replace: true });
    view.unmount();
    expect(types()).toEqual(["song.room.join"]);
  });
  it("输对密码后入房并离开加载态", async () => {
    send.mockImplementation(async (type: string, payload: { password?: string } = {}) => {
      if (type !== "song.room.join") return undefined;
      if (payload.password === "secret") return receipt();
      return rejectedProtocol({ code: "PASSWORD_INCORRECT", message: "房间密码错误" });
    });
    const view = mount();
    await screen.findByLabelText("房间密码");
    fireEvent.change(screen.getByLabelText("房间密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "加入房间" }));
    await waitFor(() => expect(screen.queryByText("正在加入房间...")).toBeNull());
    expect(send).toHaveBeenLastCalledWith(
      "song.room.join",
      { userName: "玩家", password: "secret" },
      { roomId: "1234" }
    );
    expect(navigate).not.toHaveBeenCalled();
    view.unmount();
  });
  it.each([
    ["song.room.closed", "房间已关闭"],
    ["song.room.kicked", "你已被移出房间"],
    ["session.replaced", "当前席位已在另一个标签页接管"],
  ])("入房之后收到 %s：提示并替换回大厅", async (event, text) => {
    const view = mount();
    await waitFor(() => expect(screen.queryByText("正在加入房间...")).toBeNull());
    act(() => emit(event, { roomId: "1234" }));
    expect(useSonGuessrStore.getState().showToast).toHaveBeenCalledWith(text, "error");
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/songuessr", { replace: true });
    view.unmount();
  });
  it("点离开房间：替换回大厅，页面卸载后才退房", async () => {
    const view = mount();
    await waitFor(() => expect(screen.queryByText("正在加入房间...")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "离开房间" }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/songuessr", { replace: true });
    expect(types()).toEqual(["song.room.join"]);
    view.unmount();
    await waitFor(() => expect(types()).toEqual(["song.room.join", "song.room.leave"]));
  });
  it("单人模式点离开：忘掉单人房号并替换回首页，卸载后退房", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const view = mount(true);
    await waitFor(() => expect(screen.queryByText("正在加入房间...")).toBeNull());
    const soloRoomId = send.mock.calls[0][1].roomId as string;
    expect(getSongSoloRoomId()).toBe(soloRoomId);
    fireEvent.click(screen.getByRole("button", { name: "离开房间" }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/", { replace: true });
    expect(getSongSoloRoomId()).toBeNull();
    view.unmount();
    await waitFor(() => expect(types()).toEqual(["song.room.create", "song.room.leave"]));
  });
});
