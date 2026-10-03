import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCCBStore } from "@/stores/UseCCBStore";
import CCBPage from "./CCBPage";
vi.mock("@/hooks/UsePageTransition",()=>({usePageNavigate:()=>vi.fn()}));
vi.mock("@/components/common/lobby/LobbyPage",()=>({LobbyPage:({disabled}:{disabled:boolean})=><button disabled={disabled}>加入房间</button>}));
vi.mock("@/components/common/CreateRoomDialog",()=>({CreateRoomDialog:()=>null}));
const initial=useCCBStore.getState();
afterEach(()=>useCCBStore.setState(initial,true));
function releaseFixture(){
  let resolve!:()=>void;const pending=new Promise<void>(done=>{resolve=done;});
  const leave=vi.fn(()=>pending);const subscribe=vi.fn().mockResolvedValue(undefined);
  useCCBStore.setState({roomId:"1234",connected:true,lobbyReady:true,leaveRoom:leave,subscribeLobby:subscribe});
  return {resolve,leave,subscribe};
}
it("StrictMode 返回大厅只退房一次，当前挂载在退房完成后订阅大厅",async()=>{
  const fixture=releaseFixture();render(<StrictMode><CCBPage/></StrictMode>);
  expect(fixture.leave).toHaveBeenCalledOnce();expect(screen.getByRole("button",{name:"加入房间"})).toBeDisabled();
  await act(async()=>fixture.resolve());await waitFor(()=>expect(screen.getByRole("button",{name:"加入房间"})).toBeEnabled());
  expect(fixture.subscribe).toHaveBeenCalledOnce();
});
it("大厅已经卸载时退房晚响应不再订阅",async()=>{
  const fixture=releaseFixture();const h=render(<CCBPage/>);h.unmount();await act(async()=>fixture.resolve());
  expect(fixture.subscribe).not.toHaveBeenCalled();
});
