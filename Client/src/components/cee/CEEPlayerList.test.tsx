import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CEEPlayerList } from "@/components/cee/CEEPlayerList";
import { SPECTATE_APPROVAL_WATCHDOG_MS, SPECTATE_TIMEOUT_TEXT } from "@/lib/AntiCheatCopy";
import { useCEEStore } from "@/stores/UseCEEStore";
import { ceePlayer, ceePrivateState, ceeSnapshot } from "@/stories/fixtures/CEE";

const initial = useCEEStore.getState();

const roomWith = (membership: "pendingSpectator" | "spectator") =>
  ceeSnapshot({
    hostPlayerId: "host",
    players: [
      ceePlayer({ id: "host", name: "房主" }),
      ceePlayer({ id: "me", name: "我" }, { membership }),
    ],
  });

const toastTexts = () => useCEEStore.getState().toasts.map((toast) => toast.text);

describe("CEEPlayerList 的旁观申请看门狗", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCEEStore.setState(initial, true);
  });

  afterEach(() => {
    vi.useRealTimers();
    useCEEStore.setState(initial, true);
  });

  // 服务端到点回收申请时不通知申请人：没有这条提示，申请人只会看到自己悄悄回到了参与者里。
  it("申请一直没人批，到点补一条超时提示", () => {
    render(
      <CEEPlayerList
        snapshot={roomWith("pendingSpectator")}
        privateState={ceePrivateState({ playerId: "me" })}
      />
    );
    vi.advanceTimersByTime(SPECTATE_APPROVAL_WATCHDOG_MS - 1);
    expect(toastTexts()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(toastTexts()).toEqual([SPECTATE_TIMEOUT_TEXT]);
  });

  it("到点之前申请有了结果，不再提示超时", () => {
    const view = render(
      <CEEPlayerList
        snapshot={roomWith("pendingSpectator")}
        privateState={ceePrivateState({ playerId: "me" })}
      />
    );
    view.rerender(
      <CEEPlayerList
        snapshot={roomWith("spectator")}
        privateState={ceePrivateState({ playerId: "me" })}
      />
    );
    vi.advanceTimersByTime(SPECTATE_APPROVAL_WATCHDOG_MS);
    expect(toastTexts()).toEqual([]);
  });

  it("等待中离开页面，计时器跟着作废", () => {
    const view = render(
      <CEEPlayerList
        snapshot={roomWith("pendingSpectator")}
        privateState={ceePrivateState({ playerId: "me" })}
      />
    );
    view.unmount();
    vi.advanceTimersByTime(SPECTATE_APPROVAL_WATCHDOG_MS);
    expect(toastTexts()).toEqual([]);
  });
});
