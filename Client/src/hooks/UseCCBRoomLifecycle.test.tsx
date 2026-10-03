import { renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { writeCCBSession } from "@/lib/CCBSession";
import { useCCBStore } from "@/stores/UseCCBStore";
import { useCCBRoomLifecycle } from "./UseCCBRoomLifecycle";
vi.mock("@/hooks/UsePageTransition",()=>({usePageNavigate:()=>vi.fn()}));
const initial=useCCBStore.getState();
afterEach(()=>useCCBStore.setState(initial,true));
it("小写测试房链接恢复 canonical 凭据，不要求重新加入",async()=>{
  writeCCBSession("Oblivionis","canonical-token");
  const reconnect=vi.fn().mockResolvedValue(true);useCCBStore.setState({connected:true,lobbyReady:true,reconnectRoom:reconnect});
  const h=renderHook(()=>useCCBRoomLifecycle(),{wrapper:({children})=><MemoryRouter initialEntries={["/ccb/room/oblivionis"]}><Routes><Route path="/ccb/room/:roomId" element={children}/></Routes></MemoryRouter>});
  await waitFor(()=>expect(h.result.current.joining).toBe(false));expect(reconnect).toHaveBeenCalledWith("Oblivionis",expect.any(AbortSignal));expect(h.result.current.needsJoin).toBe(false);
});
