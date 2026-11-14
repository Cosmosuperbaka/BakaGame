import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "@/test/Deferred";
import { writeCEESession } from "@/lib/CEESession";
import { useCEEStore } from "@/stores/UseCEEStore";
import { useCEERoomLifecycle } from "./UseCEERoomLifecycle";
// 与真实实现一致：同一路由上下文里 usePageNavigate 是稳定引用。
// 每次渲染返回新函数会让恢复 effect 随 navigate 变化反复重跑，房间不存在时被反复置回 needsJoin。
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/UsePageTransition", () => ({ usePageNavigate: () => navigate }));
const initial = useCEEStore.getState();
afterEach(() => {
  useCEEStore.setState(initial, true);
  navigate.mockClear();
});
it("小写测试房链接恢复 canonical 凭据，不要求重新加入", async () => {
  writeCEESession("Oblivionis", "canonical-token");
  const reconnect = vi.fn().mockResolvedValue(true);
  useCEEStore.setState({ connected: true, lobbyReady: true, reconnectRoom: reconnect });
  const h = renderHook(() => useCEERoomLifecycle(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/cee/room/oblivionis"]}>
        <Routes>
          <Route path="/cee/room/:roomId" element={children} />
        </Routes>
      </MemoryRouter>
    ),
  });
  await waitFor(() => expect(h.result.current.joining).toBe(false));
  expect(reconnect).toHaveBeenCalledWith("Oblivionis", expect.any(AbortSignal));
  expect(h.result.current.needsJoin).toBe(false);
});
it("持有凭据的房间已不在（如服务器重启）：退回大厅，不按房号开一间同号空房", async () => {
  writeCEESession("1234", "orphan-token");
  const joinRoom = vi.fn();
  const createRoom = vi.fn();
  useCEEStore.setState({
    connected: true,
    lobbyReady: true,
    reconnectRoom: vi.fn().mockImplementation(() => {
      useCEEStore.setState({ roomClosedAt: Date.now() });
      return Promise.resolve(false);
    }),
    joinRoom,
    createRoom,
  });
  renderHook(() => useCEERoomLifecycle(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/cee/room/1234"]}>
        <Routes>
          <Route path="/cee/room/:roomId" element={children} />
        </Routes>
      </MemoryRouter>
    ),
  });
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/cee", { replace: true }));
  expect(joinRoom).not.toHaveBeenCalled();
  expect(createRoom).not.toHaveBeenCalled();
});
it("上一次房间被关留下的关闭标记不会把再次进入的同一路由立即弹回大厅", async () => {
  writeCEESession("1234", "fresh-token");
  const reconnect = vi.fn().mockResolvedValue(true);
  useCEEStore.setState({
    connected: true,
    lobbyReady: true,
    roomClosedAt: Date.now() - 60_000,
    reconnectRoom: reconnect,
  });
  const h = renderHook(() => useCEERoomLifecycle(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/cee/room/1234"]}>
        <Routes>
          <Route path="/cee/room/:roomId" element={children} />
        </Routes>
      </MemoryRouter>
    ),
  });
  await waitFor(() => expect(h.result.current.joining).toBe(false));
  expect(reconnect).toHaveBeenCalledWith("1234", expect.any(AbortSignal));
  expect(navigate).not.toHaveBeenCalledWith("/cee", { replace: true });
  expect(useCEEStore.getState().roomClosedAt).toBeNull();
  useCEEStore.setState({ roomClosedAt: Date.now() });
  h.unmount();
  expect(useCEEStore.getState().roomClosedAt).toBeNull();
});
it("测试房直链房间不存在时自动用本地用户名按规范房号创建后进入，不弹设置用户名", async () => {
  localStorage.setItem("bakagame:username", "测试房主");
  const joinRoom = vi
    .fn()
    .mockRejectedValue({ code: "ROOM_NOT_FOUND", message: "房间不存在或已关闭" });
  const createRoom = vi.fn().mockResolvedValue(undefined);
  useCEEStore.setState({
    connected: true,
    lobbyReady: true,
    reconnectRoom: vi.fn().mockResolvedValue(false),
    joinRoom,
    createRoom,
  });
  const h = renderHook(() => useCEERoomLifecycle(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/cee/room/oblivionis"]}>
        <Routes>
          <Route path="/cee/room/:roomId" element={children} />
        </Routes>
      </MemoryRouter>
    ),
  });
  await waitFor(() => expect(h.result.current.joining).toBe(false));
  expect(joinRoom).toHaveBeenCalledWith("Oblivionis", "测试房主", "", expect.any(AbortSignal));
  expect(createRoom).toHaveBeenCalledWith(
    {
      source: "native",
      roomId: "Oblivionis",
      name: "CEE 测试房",
      userName: "测试房主",
      visibility: "public",
      allowSpectators: true,
    },
    expect.any(AbortSignal)
  );
  expect(h.result.current.needsJoin).toBe(false);
});
it("直链进房且本地无用户名时自动取访客名加入，不要求填名字", async () => {
  localStorage.removeItem("bakagame:username");
  const joinRoom = vi.fn().mockResolvedValue(undefined);
  useCEEStore.setState({
    connected: true,
    lobbyReady: true,
    reconnectRoom: vi.fn().mockResolvedValue(false),
    joinRoom,
    createRoom: vi.fn(),
  });
  const h = renderHook(() => useCEERoomLifecycle(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/cee/room/1234"]}>
        <Routes>
          <Route path="/cee/room/:roomId" element={children} />
        </Routes>
      </MemoryRouter>
    ),
  });
  await waitFor(() => expect(joinRoom).toHaveBeenCalled());
  expect(joinRoom).toHaveBeenCalledWith(
    "1234",
    expect.stringMatching(/^玩家\d{4}$/),
    "",
    expect.any(AbortSignal)
  );
  await waitFor(() => expect(h.result.current.joining).toBe(false));
  expect(h.result.current.needsJoin).toBe(false);
});
it("加入被业务拒绝时不触发建房，错误码就地展示", async () => {
  const joinRoom = vi
    .fn()
    .mockRejectedValue({ code: "PASSWORD_INCORRECT", message: "房间密码错误" });
  const createRoom = vi.fn();
  useCEEStore.setState({
    connected: true,
    lobbyReady: true,
    reconnectRoom: vi.fn().mockResolvedValue(false),
    joinRoom,
    createRoom,
  });
  const h = renderHook(() => useCEERoomLifecycle(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/cee/room/1234"]}>
        <Routes>
          <Route path="/cee/room/:roomId" element={children} />
        </Routes>
      </MemoryRouter>
    ),
  });
  await waitFor(() => expect(h.result.current.joining).toBe(false));
  act(() => h.result.current.setName("访客"));
  await act(async () => {
    await h.result.current.join();
  });
  expect(createRoom).not.toHaveBeenCalled();
  expect(h.result.current.errorCode).toBe("PASSWORD_INCORRECT");
});
it("直链进私密房缺密码时落到密码步，不一直转圈", async () => {
  const joinRoom = vi
    .fn()
    .mockRejectedValue({ code: "PASSWORD_REQUIRED", message: "需要房间密码" });
  useCEEStore.setState({
    connected: true,
    lobbyReady: true,
    reconnectRoom: vi.fn().mockResolvedValue(false),
    joinRoom,
    createRoom: vi.fn(),
  });
  const h = renderHook(() => useCEERoomLifecycle(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/cee/room/1234"]}>
        <Routes>
          <Route path="/cee/room/:roomId" element={children} />
        </Routes>
      </MemoryRouter>
    ),
  });
  await waitFor(() => expect(h.result.current.needsJoin).toBe(true));
  expect(h.result.current.errorCode).toBe("PASSWORD_REQUIRED");
  await waitFor(() => expect(h.result.current.joining).toBe(false));
});
it("直链加入被非密码类拒绝时回大厅并提示", async () => {
  const joinRoom = vi.fn().mockRejectedValue({ code: "ROOM_FULL", message: "房间已满" });
  useCEEStore.setState({
    connected: true,
    lobbyReady: true,
    reconnectRoom: vi.fn().mockResolvedValue(false),
    joinRoom,
    createRoom: vi.fn(),
  });
  const h = renderHook(() => useCEERoomLifecycle(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/cee/room/1234"]}>
        <Routes>
          <Route path="/cee/room/:roomId" element={children} />
        </Routes>
      </MemoryRouter>
    ),
  });
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/cee", { replace: true }));
  expect(useCEEStore.getState().toasts[0]?.text).toBe("房间已满");
  await waitFor(() => expect(h.result.current.joining).toBe(false));
});
it("恢复会话临时失败时回大厅提示，不卡在正在加入", async () => {
  useCEEStore.setState({
    connected: true,
    lobbyReady: true,
    reconnectRoom: vi.fn().mockRejectedValue({ code: "DISCONNECTED", message: "连接已断开" }),
    joinRoom: vi.fn(),
    createRoom: vi.fn(),
  });
  const h = renderHook(() => useCEERoomLifecycle(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/cee/room/1234"]}>
        <Routes>
          <Route path="/cee/room/:roomId" element={children} />
        </Routes>
      </MemoryRouter>
    ),
  });
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/cee", { replace: true }));
  expect(useCEEStore.getState().toasts[0]?.text).toBe("连接已断开");
  await waitFor(() => expect(h.result.current.joining).toBe(false));
});

describe("CEE 直链入房的分支与去向（补充）", () => {
  const mount = (strict = false) =>
    renderHook(() => useCEERoomLifecycle(), {
      wrapper: ({ children }) => {
        const router = (
          <MemoryRouter initialEntries={["/cee/room/1234"]}>
            <Routes>
              <Route path="/cee/room/:roomId" element={children} />
            </Routes>
          </MemoryRouter>
        );
        return strict ? <StrictMode>{router}</StrictMode> : router;
      },
    });
  const ready = (overrides: Record<string, unknown> = {}) => {
    const store = {
      connected: true,
      lobbyReady: true,
      reconnectRoom: vi.fn().mockResolvedValue(false),
      joinRoom: vi.fn().mockResolvedValue(undefined),
      createRoom: vi.fn().mockResolvedValue(undefined),
      leaveRoom: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    useCEEStore.setState(store);
    return store;
  };
  beforeEach(() => localStorage.setItem("bakagame:username", "玩家"));
  afterEach(() => localStorage.clear());

  it("严格模式下直链加入只发一次入房", async () => {
    const { joinRoom } = ready();
    const h = mount(true);
    await waitFor(() => expect(h.result.current.joining).toBe(false));
    expect(joinRoom).toHaveBeenCalledExactlyOnceWith("1234", "玩家", "", expect.any(AbortSignal));
    expect(navigate).not.toHaveBeenCalled();
  });
  it("未连上或大厅未就绪时不入房，两者都就绪后才恢复与加入", async () => {
    const { reconnectRoom, joinRoom } = ready({ connected: false });
    const h = mount();
    await act(async () => {});
    expect(reconnectRoom).not.toHaveBeenCalled();
    act(() => useCEEStore.setState({ connected: true, lobbyReady: false }));
    await act(async () => {});
    expect(reconnectRoom).not.toHaveBeenCalled();
    act(() => useCEEStore.setState({ lobbyReady: true }));
    await waitFor(() => expect(h.result.current.joining).toBe(false));
    expect(reconnectRoom).toHaveBeenCalledTimes(1);
    expect(joinRoom).toHaveBeenCalledTimes(1);
  });
  it("恢复途中断线：作废这次入房，重新就绪后从恢复重来", async () => {
    const pending = deferred<boolean>();
    const { reconnectRoom, joinRoom } = ready();
    reconnectRoom.mockReturnValueOnce(pending.promise);
    const h = mount();
    await waitFor(() => expect(reconnectRoom).toHaveBeenCalledTimes(1));
    const firstSignal = reconnectRoom.mock.calls[0][1] as AbortSignal;
    act(() => useCEEStore.setState({ connected: false }));
    expect(firstSignal.aborted).toBe(true);
    await act(async () => pending.resolve(false));
    expect(joinRoom).not.toHaveBeenCalled();
    act(() => useCEEStore.setState({ connected: true }));
    await waitFor(() => expect(h.result.current.joining).toBe(false));
    expect(reconnectRoom).toHaveBeenCalledTimes(2);
    expect(joinRoom).toHaveBeenCalledTimes(1);
  });
  it("尝试过多同样落到密码步，就地给出错误码", async () => {
    ready({
      joinRoom: vi.fn().mockRejectedValue({ code: "TOO_MANY_ATTEMPTS", message: "尝试次数过多" }),
    });
    const h = mount();
    await waitFor(() => expect(h.result.current.needsJoin).toBe(true));
    expect(h.result.current.errorCode).toBe("TOO_MANY_ATTEMPTS");
    expect(h.result.current.error).toBe("尝试次数过多");
    expect(navigate).not.toHaveBeenCalled();
  });
  it("密码步确认：在途时再次确认被忽略，成功后记住名字并收起密码步", async () => {
    const retry = deferred<void>();
    const { joinRoom } = ready({
      joinRoom: vi
        .fn()
        .mockRejectedValueOnce({ code: "PASSWORD_REQUIRED", message: "需要房间密码" })
        .mockReturnValueOnce(retry.promise),
    });
    const h = mount();
    await waitFor(() => expect(h.result.current.needsJoin).toBe(true));
    act(() => h.result.current.setName("新名字"));
    act(() => h.result.current.setPassword("secret"));
    let first!: Promise<void>;
    act(() => {
      first = h.result.current.join();
    });
    expect(h.result.current.joining).toBe(true);
    expect(h.result.current.errorCode).toBe("");
    await act(async () => h.result.current.join());
    expect(joinRoom).toHaveBeenCalledTimes(2);
    expect(joinRoom.mock.calls[1]).toEqual(["1234", "新名字", "secret", expect.any(AbortSignal)]);
    await act(async () => {
      retry.resolve();
      await first;
    });
    expect(h.result.current.needsJoin).toBe(false);
    expect(h.result.current.joining).toBe(false);
    expect(localStorage.getItem("bakagame:username")).toBe("新名字");
  });
  it("房间不存在且建房失败：提示后替换回大厅", async () => {
    ready({
      joinRoom: vi.fn().mockRejectedValue({ code: "ROOM_NOT_FOUND", message: "房间不存在" }),
      createRoom: vi.fn().mockRejectedValue({ code: "ROOM_LIMIT", message: "房间数已达上限" }),
    });
    const h = mount();
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledExactlyOnceWith("/cee", { replace: true })
    );
    expect(useCEEStore.getState().toasts[0]?.text).toBe("房间数已达上限");
    await waitFor(() => expect(h.result.current.joining).toBe(false));
  });
  it("入房被 store 以取消拒绝：不提示也不退出", async () => {
    ready({
      joinRoom: vi.fn().mockRejectedValue(new DOMException("入房操作已取消", "AbortError")),
    });
    const h = mount();
    await waitFor(() => expect(h.result.current.joining).toBe(false));
    expect(navigate).not.toHaveBeenCalled();
    expect(useCEEStore.getState().toasts).toHaveLength(0);
    expect(h.result.current.needsJoin).toBe(false);
  });
  it("入房之后房间被关：替换回大厅", async () => {
    const h = mount();
    ready();
    await waitFor(() => expect(h.result.current.joining).toBe(false));
    act(() => useCEEStore.setState({ roomClosedAt: Date.now() + 1 }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/cee", { replace: true });
  });
  it("点离开只回大厅（不替换历史），卸载时不退房", async () => {
    const { leaveRoom } = ready();
    const h = mount();
    await waitFor(() => expect(h.result.current.joining).toBe(false));
    act(() => h.result.current.leave());
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/cee");
    h.unmount();
    expect(leaveRoom).not.toHaveBeenCalled();
  });
});
