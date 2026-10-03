import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WhoIsFakerProvider } from "@/contexts/WhoIsFakerContext";
import { SonGuessrProvider } from "@/contexts/SonGuessrContext";
import { initCCBWs, useCCBStore } from "@/stores/UseCCBStore";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
vi.mock("@/lib/Sentry", () => ({
  captureClientLog:vi.fn(), captureClientException:vi.fn(), countClientMetric:vi.fn(), recordClientMetric:vi.fn(),
  withClientSpan:async(_name:string,callback:(span:unknown)=>unknown)=>callback({setStatus:()=>{},setAttribute:()=>{}}),
}));
class FakeSocket {
  static OPEN=1; static CONNECTING=0; static instances:FakeSocket[]=[];
  readyState=0;close=vi.fn(()=>{this.readyState=3;this.onclose?.();});send=vi.fn();
  onopen:(()=>void)|null=null;onclose:(()=>void)|null=null;onmessage:((event:{data:string})=>void)|null=null;onerror:(()=>void)|null=null;
  url: string;
  constructor(url:string){this.url=url;FakeSocket.instances.push(this);}
}
beforeEach(()=>{vi.useFakeTimers();FakeSocket.instances=[];vi.stubGlobal("WebSocket",FakeSocket);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it.each(["Faker","Song","CCB"])("%s 玩法释放真实客户端后不再重连，StrictMode再次挂载仍只拥有一条连接",async(game)=>{
  const mount=()=>{
    if(game==="CCB")return {unmount:initCCBWs()};
    const Provider=game==="Faker"?WhoIsFakerProvider:SonGuessrProvider;
    return render(<StrictMode><Provider><span>玩法</span></Provider></StrictMode>);
  };
  const h=mount();const first=FakeSocket.instances.at(-1)!;first.readyState=1;first.onopen?.();
  h.unmount();expect(first.close).toHaveBeenCalledOnce();expect(first.onclose).toBeNull();
  const count=FakeSocket.instances.length;await vi.advanceTimersByTimeAsync(60000);expect(FakeSocket.instances).toHaveLength(count);
  const store=game==="Faker"?useWhoIsFakerStore:game==="Song"?useSonGuessrStore:useCCBStore;
  expect(store.getState()).toMatchObject({connected:false,lobbyReady:false});
  const next=mount();const active=FakeSocket.instances.filter(s=>s.readyState===0||s.readyState===1);expect(active).toHaveLength(1);
  // 已排队的 onclose 重连也必须在玩法释放时取消。
  active[0].onclose?.();next.unmount();const finalCount=FakeSocket.instances.length;
  await vi.advanceTimersByTimeAsync(60000);expect(FakeSocket.instances).toHaveLength(finalCount);
});
