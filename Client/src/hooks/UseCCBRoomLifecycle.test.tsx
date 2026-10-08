import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { writeCCBSession } from "@/lib/CCBSession";
import { useCCBStore } from "@/stores/UseCCBStore";
import { useCCBRoomLifecycle } from "./UseCCBRoomLifecycle";
// 与真实实现一致：同一路由上下文里 usePageNavigate 是稳定引用。
// 每次渲染返回新函数会让恢复 effect 随 navigate 变化反复重跑，房间不存在时被反复置回 needsJoin。
vi.mock("@/hooks/UsePageTransition",()=>{
  const navigate=vi.fn();
  return {usePageNavigate:()=>navigate};
});
const initial=useCCBStore.getState();
afterEach(()=>useCCBStore.setState(initial,true));
it("小写测试房链接恢复 canonical 凭据，不要求重新加入",async()=>{
  writeCCBSession("Oblivionis","canonical-token");
  const reconnect=vi.fn().mockResolvedValue(true);useCCBStore.setState({connected:true,lobbyReady:true,reconnectRoom:reconnect});
  const h=renderHook(()=>useCCBRoomLifecycle(),{wrapper:({children})=><MemoryRouter initialEntries={["/ccb/room/oblivionis"]}><Routes><Route path="/ccb/room/:roomId" element={children}/></Routes></MemoryRouter>});
  await waitFor(()=>expect(h.result.current.joining).toBe(false));expect(reconnect).toHaveBeenCalledWith("Oblivionis",expect.any(AbortSignal));expect(h.result.current.needsJoin).toBe(false);
});
it("测试房直链房间不存在时按规范房号创建后进入",async()=>{
  const joinRoom=vi.fn().mockRejectedValue({code:"ROOM_NOT_FOUND",message:"房间不存在或已经关闭"});
  const createRoom=vi.fn().mockResolvedValue(undefined);
  useCCBStore.setState({connected:true,lobbyReady:true,reconnectRoom:vi.fn().mockResolvedValue(false),joinRoom,createRoom});
  const h=renderHook(()=>useCCBRoomLifecycle(),{wrapper:({children})=><MemoryRouter initialEntries={["/ccb/room/oblivionis"]}><Routes><Route path="/ccb/room/:roomId" element={children}/></Routes></MemoryRouter>});
  await waitFor(()=>expect(h.result.current.joining).toBe(false));expect(h.result.current.needsJoin).toBe(true);
  act(()=>h.result.current.setName("测试房主"));
  await act(async()=>{await h.result.current.join();});
  expect(joinRoom).toHaveBeenCalledWith("Oblivionis","测试房主","",expect.any(AbortSignal));
  expect(createRoom).toHaveBeenCalledWith({source:"native",roomId:"Oblivionis",name:"CCB 测试房",userName:"测试房主",visibility:"public",allowSpectators:true},expect.any(AbortSignal));
  expect(h.result.current.needsJoin).toBe(false);
});
it("加入被业务拒绝时不触发建房，错误码就地展示",async()=>{
  const joinRoom=vi.fn().mockRejectedValue({code:"PASSWORD_INCORRECT",message:"房间密码错误"});
  const createRoom=vi.fn();
  useCCBStore.setState({connected:true,lobbyReady:true,reconnectRoom:vi.fn().mockResolvedValue(false),joinRoom,createRoom});
  const h=renderHook(()=>useCCBRoomLifecycle(),{wrapper:({children})=><MemoryRouter initialEntries={["/ccb/room/1234"]}><Routes><Route path="/ccb/room/:roomId" element={children}/></Routes></MemoryRouter>});
  await waitFor(()=>expect(h.result.current.joining).toBe(false));
  act(()=>h.result.current.setName("访客"));
  await act(async()=>{await h.result.current.join();});
  expect(createRoom).not.toHaveBeenCalled();
  expect(h.result.current.errorCode).toBe("PASSWORD_INCORRECT");
});
