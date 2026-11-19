import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CEEPlayerList } from "@/components/cee/CEEPlayerList";
import {
  SPECTATE_APPROVAL_WATCHDOG_MS,
  SPECTATE_APPROVE_LABEL,
  SPECTATE_REJECT_LABEL,
  SPECTATE_TIMEOUT_TEXT,
} from "@/lib/AntiCheatCopy";
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

describe("CEEPlayerList 房主操作指令", () => {
  beforeEach(() => {
    useCEEStore.setState(initial, true);
  });

  afterEach(() => {
    useCEEStore.setState(initial, true);
  });

  const hostRoom = () =>
    ceeSnapshot({
      hostPlayerId: "me",
      players: [
        ceePlayer({ id: "me", name: "我" }, { ready: true }),
        ceePlayer({ id: "p2", name: "玩家甲" }),
        ceePlayer({ id: "obs-1", name: "旁观者" }, { membership: "spectator" }),
      ],
    });

  const renderHost = () =>
    render(
      <CEEPlayerList snapshot={hostRoom()} privateState={ceePrivateState({ playerId: "me" })} />
    );

  it("踢出玩家发出 cee.room.kick 并带目标玩家编号", async () => {
    const user = userEvent.setup();
    const sendCommand = vi.fn().mockResolvedValue({});
    useCEEStore.setState({ sendCommand: sendCommand as never });
    renderHost();

    await user.click(screen.getByRole("button", { name: "玩家甲 操作" }));
    await user.click(await screen.findByRole("button", { name: "踢出玩家" }));
    expect(sendCommand).toHaveBeenCalledWith("cee.room.kick", { playerId: "p2" });
  });

  it("转移房主发出 cee.room.transferHost 并带目标玩家编号", async () => {
    const user = userEvent.setup();
    const sendCommand = vi.fn().mockResolvedValue({});
    useCEEStore.setState({ sendCommand: sendCommand as never });
    renderHost();

    await user.click(screen.getByRole("button", { name: "玩家甲 操作" }));
    await user.click(await screen.findByRole("button", { name: "转移房主" }));
    expect(sendCommand).toHaveBeenCalledWith("cee.room.transferHost", { playerId: "p2" });
  });

  it("加入旁观发出 cee.player.spectate", async () => {
    const user = userEvent.setup();
    const sendCommand = vi.fn().mockResolvedValue({});
    useCEEStore.setState({ sendCommand: sendCommand as never });
    renderHost();

    await user.click(screen.getByRole("button", { name: "加入旁观" }));
    expect(sendCommand).toHaveBeenCalledWith("cee.player.spectate", { spectator: true });
  });

  it("同意与拒绝旁观申请各发一条 approveSpectate", async () => {
    const user = userEvent.setup();
    const sendCommand = vi.fn().mockResolvedValue({});
    useCEEStore.setState({ sendCommand: sendCommand as never });
    const snapshot = ceeSnapshot({
      hostPlayerId: "me",
      bakaAntiCheat: true,
      players: [
        ceePlayer({ id: "me", name: "我" }, { ready: true }),
        ceePlayer({ id: "req-1", name: "请求者" }, { membership: "pendingSpectator" }),
      ],
      spectateRequests: [{ playerId: "req-1", name: "请求者", requestedAt: 0 }],
    });
    render(
      <CEEPlayerList snapshot={snapshot} privateState={ceePrivateState({ playerId: "me" })} />
    );

    await user.click(screen.getByRole("button", { name: SPECTATE_APPROVE_LABEL }));
    expect(sendCommand).toHaveBeenCalledWith("cee.player.approveSpectate", {
      playerId: "req-1",
      approved: true,
    });
    await user.click(screen.getByRole("button", { name: `${SPECTATE_REJECT_LABEL} 请求者` }));
    expect(sendCommand).toHaveBeenCalledWith("cee.player.approveSpectate", {
      playerId: "req-1",
      approved: false,
    });
  });

  it("命令在途时按钮禁用", async () => {
    let finish!: () => void;
    const sendCommand = vi.fn(
      () =>
        new Promise<object>((resolve) => {
          finish = () => resolve({});
        })
    );
    useCEEStore.setState({ sendCommand: sendCommand as never });
    renderHost();

    const toggle = screen.getByRole("button", { name: "加入旁观" });
    await act(async () => {
      toggle.click();
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(toggle).toBeDisabled();
    await act(async () => finish());
    expect(toggle).toBeEnabled();
  });

  // 锁按命令粒度：同一命令在途时重复调用被忽略，与另两款的共享锁口径不同。
  it("同一命令在途时同一帧连点只发一条", () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    useCEEStore.setState({ sendCommand: sendCommand as never });
    renderHost();

    const toggle = screen.getByRole("button", { name: "加入旁观" });
    act(() => {
      toggle.click();
      toggle.click();
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith("cee.player.spectate", { spectator: true });
  });

  it("命令失败时经统一入口提示", async () => {
    const sendCommand = vi.fn().mockRejectedValueOnce(new Error("只有房主可以操作"));
    useCEEStore.setState({ sendCommand: sendCommand as never });
    renderHost();

    await act(async () => screen.getByRole("button", { name: "加入旁观" }).click());
    expect(toastTexts()).toEqual(["只有房主可以操作"]);
  });
});
