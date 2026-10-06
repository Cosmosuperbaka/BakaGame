import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLobbySession } from "./UseLobbySession";
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@/hooks/UsePageTransition", () => ({ usePageNavigate: () => navigate }));
const room: { roomId: string; name: string; hasPassword?: boolean } = { roomId: "1234", name: "测试房" };
const event = { currentTarget: document.createElement("button") } as unknown as React.MouseEvent<HTMLElement>;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
function setup(overrides = {}) {
  const options = { gamePath: "/ccb", rooms: [room], ready: true, createRoom: vi.fn().mockResolvedValue(undefined), joinRoom: vi.fn().mockResolvedValue(undefined), reconnectRoom: vi.fn().mockResolvedValue(false), showError: vi.fn(), ...overrides };
  const hook = renderHook((props) => useLobbySession(props), { initialProps: options });
  return { ...hook, options };
}
beforeEach(() => { navigate.mockClear(); localStorage.setItem("wif_username", "玩家"); });
describe("大厅入房事务", () => {
  it("恢复拒绝被统一接住，不继续加入或导航", async () => {
    const h=setup({ reconnectRoom: vi.fn().mockRejectedValue({ code: "DISCONNECTED", message: "连接已断开" }) });
    await act(async()=>{ await h.result.current.handleJoinRoom(room,event); });
    expect(h.options.showError).toHaveBeenCalledExactlyOnceWith("连接已断开");
    expect(h.options.joinRoom).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });
  it("同房与跨房重入都不发送第二个请求", async () => {
    const ack=deferred<boolean>(); const h=setup({ reconnectRoom: vi.fn(()=>ack.promise) });
    let first!: Promise<void>;
    act(()=>{first=h.result.current.handleJoinRoom(room,event);});
    expect(h.result.current.pending).toBe(true);
    await act(async()=>{await h.result.current.handleJoinRoom({ ...room, roomId:"5678" },event);});
    expect(h.options.reconnectRoom).toHaveBeenCalledTimes(1);
    await act(async()=>{ack.resolve(false);await first;});
    expect(h.options.joinRoom).toHaveBeenCalledExactlyOnceWith("1234","玩家",undefined,expect.any(AbortSignal));
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/ccb/room/1234"); expect(h.result.current.pending).toBe(false);
  });
  it("卸载后恢复响应不再发加入、显示错误或导航", async () => {
    const ack=deferred<boolean>();const h=setup({reconnectRoom:vi.fn(()=>ack.promise)}); let task!:Promise<void>;
    act(()=>{task=h.result.current.handleJoinRoom(room,event);}); h.unmount(); ack.resolve(false); await task;
    expect(h.options.joinRoom).not.toHaveBeenCalled();expect(navigate).not.toHaveBeenCalled();expect(h.options.showError).not.toHaveBeenCalled();
  });
  it("取消密码对话框使在途加入响应失效", async () => {
    const ack=deferred<void>();const h=setup({joinRoom:vi.fn(()=>ack.promise)});
    await act(async()=>{await h.result.current.handleJoinRoom({...room,hasPassword:true},event);});
    act(()=>h.result.current.setJoinPassword("secret")); let task!:Promise<void>;
    act(()=>{task=h.result.current.handlePasswordJoin();});act(()=>h.result.current.setJoinTarget(null));
    await act(async()=>{ack.resolve();await task;});expect(navigate).not.toHaveBeenCalled();expect(h.result.current.joinTarget).toBeNull();
  });
  it("创建 ACK 在卸载后不导航", async()=>{
    const ack=deferred<void>();const h=setup({createRoom:vi.fn(()=>ack.promise)});let task!:Promise<void>;
    act(()=>{task=h.result.current.handleCreateRoom({name:"新房",visibility:"public",allowSpectators:true});});h.unmount();ack.resolve();await task;expect(navigate).not.toHaveBeenCalled();
  });
  it("恢复成功直接导航而不再加入", async()=>{
    const h=setup({reconnectRoom:vi.fn().mockResolvedValue(true)});
    await act(async()=>{await h.result.current.handleJoinRoom(room,event);});expect(navigate).toHaveBeenCalledExactlyOnceWith("/ccb/room/1234");expect(h.options.joinRoom).not.toHaveBeenCalled();
  });
});
it("换游戏后旧恢复响应不导航，新页面不接受过期意图",async()=>{
  const ack=deferred<boolean>();const h=setup({reconnectRoom:vi.fn(()=>ack.promise)});let task!:Promise<void>;
  act(()=>{task=h.result.current.handleJoinRoom(room,event);});h.rerender({...h.options,gamePath:"/songuessr"});
  await act(async()=>{ack.resolve(true);await task;});expect(navigate).not.toHaveBeenCalled();
});
it("关闭创建对话框的晚 ACK 不导航",async()=>{
  const ack=deferred<void>();const h=setup({createRoom:vi.fn(()=>ack.promise)});let task!:Promise<void>;
  act(()=>{h.result.current.setCreateOpen(true);task=h.result.current.handleCreateRoom({name:"新房",visibility:"public",allowSpectators:true});});
  act(()=>h.result.current.setCreateOpen(false));await act(async()=>{ack.resolve();await task;});expect(navigate).not.toHaveBeenCalled();
});
it("密码加入失败写在密码弹窗里：密码错误标红，其余失败只给文案，都不弹 Toast", async () => {
  const joinRoom = vi.fn()
    .mockRejectedValueOnce({ code: "PASSWORD_INCORRECT", message: "房间密码错误" })
    .mockRejectedValueOnce({ code: "TOO_MANY_ATTEMPTS", message: "密码错误次数过多，请稍后再试" });
  const h = setup({ joinRoom });
  await act(async () => { await h.result.current.handleJoinRoom({ ...room, hasPassword: true }, event); });
  act(() => h.result.current.setJoinPassword("wrong"));
  await act(async () => { await h.result.current.handlePasswordJoin(); });
  expect(h.result.current.joinError).toEqual({ message: "房间密码错误", invalid: true });
  // 改密码即撤下上一次的错误。
  act(() => h.result.current.setJoinPassword("again"));
  expect(h.result.current.joinError).toBeNull();
  await act(async () => { await h.result.current.handlePasswordJoin(); });
  expect(h.result.current.joinError).toEqual({ message: "密码错误次数过多，请稍后再试", invalid: false });
  expect(h.options.showError).not.toHaveBeenCalled();
});
it("进房在途时记下是哪间房，结束后清空", async () => {
  const ack = deferred<boolean>(); const h = setup({ reconnectRoom: vi.fn(() => ack.promise) });
  let task!: Promise<void>;
  act(() => { task = h.result.current.handleJoinRoom(room, event); });
  expect(h.result.current.pendingRoomId).toBe("1234");
  await act(async () => { ack.resolve(true); await task; });
  expect(h.result.current.pendingRoomId).toBeNull();
});
it("建房失败抛回给弹窗、不另弹 Toast", async () => {
  const h = setup({ createRoom: vi.fn().mockRejectedValue(new Error("房间已满")) });
  await act(async () => {
    await expect(h.result.current.handleCreateRoom({ name: "新房", visibility: "public", allowSpectators: true })).rejects.toThrow("房间已满");
  });
  expect(h.options.showError).not.toHaveBeenCalled();
});
