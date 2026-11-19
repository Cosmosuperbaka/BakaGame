import { StrictMode, useEffect } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initCEEWs, useCEEStore } from "@/stores/UseCEEStore";
import { initWhoIsFakerWs, useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { initSonGuessrWs, useSonGuessrStore } from "@/stores/UseSonGuessrStore";
vi.mock("@/lib/Sentry", () => ({
  captureClientLog: vi.fn(),
  captureClientException: vi.fn(),
  countClientMetric: vi.fn(),
  recordClientMetric: vi.fn(),
  withClientSpan: async (_name: string, callback: (span: unknown) => unknown) =>
    callback({ setStatus: () => {}, setAttribute: () => {} }),
}));
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = 0;
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  send = vi.fn();
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
}
/** 布局在 effect 里初始化连接并交回清理；这里只驱动同一份契约，不带布局的其余子树。 */
function Connection({ init }: { init: () => () => void }) {
  useEffect(() => init(), [init]);
  return <span>玩法</span>;
}
beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each(["Faker", "Song", "CEE"])(
  "%s 玩法释放真实客户端后不再重连，StrictMode再次挂载仍只拥有一条连接",
  async (game) => {
    const mount = () => {
      if (game === "CEE") return { unmount: initCEEWs() };
      const init = game === "Faker" ? initWhoIsFakerWs : initSonGuessrWs;
      return render(
        <StrictMode>
          <Connection init={init} />
        </StrictMode>
      );
    };
    const h = mount();
    const first = FakeSocket.instances.at(-1)!;
    first.readyState = 1;
    first.onopen?.();
    h.unmount();
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.onclose).toBeNull();
    const count = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeSocket.instances).toHaveLength(count);
    const store =
      game === "Faker" ? useWhoIsFakerStore : game === "Song" ? useSonGuessrStore : useCEEStore;
    expect(store.getState()).toMatchObject({ connected: false, lobbyReady: false });
    const next = mount();
    const active = FakeSocket.instances.filter((s) => s.readyState === 0 || s.readyState === 1);
    expect(active).toHaveLength(1);
    // 已排队的 onclose 重连也必须在玩法释放时取消。
    active[0].onclose?.();
    next.unmount();
    const finalCount = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeSocket.instances).toHaveLength(finalCount);
  }
);
