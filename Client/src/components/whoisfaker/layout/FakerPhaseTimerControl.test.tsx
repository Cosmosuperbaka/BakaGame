import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WhoIsFakerPrivateState, WhoIsFakerRoomSnapshot } from "@bakagame/shared";
import { recordClockSample, resetClockSample } from "@/stores/UseServerClock";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { FakerPhaseTimerControl } from "./FakerPhaseTimerControl";

const createBaseSnapshot = (
  phase: WhoIsFakerRoomSnapshot["status"]["phase"] = "description"
): WhoIsFakerRoomSnapshot => ({
  roomId: "1234",
  name: "测试房间",
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  hostPlayerId: "host_1",
  testMode: false,
  roleLimits: {
    maxUndercoverCount: 1,
    canEnableAngel: false,
    canEnableBlank: false,
  },
  settings: {
    roleConfig: { undercoverCount: 1, hasAngel: false, hasBlank: false },
  },
  status: {
    phase,
    started: true,
    day: 1,
    questionerPlayerId: "host_1",
  },
  players: [
    {
      id: "host_1",
      name: "出题人",
      score: 0,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: true,
      roundStatus: "alive",
    },
    {
      id: "player_2",
      name: "普通玩家",
      score: 0,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "alive",
    },
  ],
  descriptions: [],
  chat: [],
});

const createPrivateState = (isQuestioner = true, playerId = "host_1"): WhoIsFakerPrivateState => ({
  playerId,
  sessionToken: "session_token",
  isQuestioner,
  canSubmitBlankGuess: false,
  blankGuessUsed: false,
  nightActionSubmitted: false,
});

describe("PhaseTimerControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("在出题阶段、等待阶段以及非主持人普通玩家视角下，无倒计时时不渲染任何内容", () => {
    // 1. 等待阶段（主持人）
    useWhoIsFakerStore.setState({
      snapshot: createBaseSnapshot("waiting"),
      privateState: createPrivateState(true, "host_1"),
    });
    const { container, rerender } = render(<FakerPhaseTimerControl />);
    expect(container.firstChild).toBeNull();

    // 2. 选择出题人阶段（房主）
    useWhoIsFakerStore.setState({
      snapshot: createBaseSnapshot("assigningQuestioner"),
      privateState: createPrivateState(false, "host_1"),
    });
    rerender(<FakerPhaseTimerControl />);
    expect(container.firstChild).toBeNull();

    // 3. 出题阶段（主持人）
    useWhoIsFakerStore.setState({
      snapshot: createBaseSnapshot("wordSubmission"),
      privateState: createPrivateState(true, "host_1"),
    });
    rerender(<FakerPhaseTimerControl />);
    expect(container.firstChild).toBeNull();

    // 4. 描述阶段（普通玩家）
    useWhoIsFakerStore.setState({
      snapshot: createBaseSnapshot("description"),
      privateState: createPrivateState(false, "player_2"),
    });
    rerender(<FakerPhaseTimerControl />);
    expect(container.firstChild).toBeNull();
  });

  it("支持的阶段中，主持人可以看到 1/2/3 分钟选择器并发送开启倒计时指令", async () => {
    const sendCommandMock = vi.fn().mockResolvedValue({});
    useWhoIsFakerStore.setState({
      snapshot: createBaseSnapshot("description"),
      privateState: createPrivateState(true, "host_1"),
      sendCommand: sendCommandMock,
    });

    render(<FakerPhaseTimerControl />);

    expect(screen.getByTestId("host-timer-bar")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "倒计时时长" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "1分钟" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "2分钟" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "3分钟" })).toBeInTheDocument();

    // 切换为 2 分钟并点击开启
    fireEvent.click(screen.getByRole("radio", { name: "2分钟" }));
    expect(screen.getByRole("radio", { name: "2分钟" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "开启倒计时" }));

    await waitFor(() => {
      expect(sendCommandMock).toHaveBeenCalledWith("game.startPhaseTimer", {
        durationSeconds: 120,
      });
    });
  });

  it("开启倒计时后，全员操作区显示倒计时与进度条，主持人可点击取消", async () => {
    const sendCommandMock = vi.fn().mockResolvedValue({});
    const snapshotWithTimer = createBaseSnapshot("description");
    snapshotWithTimer.status.phaseTimer = {
      durationSeconds: 60,
      endsAt: Date.now() + 50000,
      phase: "description",
    };

    useWhoIsFakerStore.setState({
      snapshot: snapshotWithTimer,
      privateState: createPrivateState(true, "host_1"),
      sendCommand: sendCommandMock,
    });

    render(<FakerPhaseTimerControl />);

    expect(screen.getByText("本阶段倒计时")).toBeInTheDocument();
    const cancelButton = screen.getByRole("button", { name: /取消/ });
    expect(cancelButton).toBeInTheDocument();

    fireEvent.click(cancelButton);
    await waitFor(() => {
      expect(sendCommandMock).toHaveBeenCalledWith("game.stopPhaseTimer", {});
    });
  });

  it("倒计时归零时触发 onTimeout 回调并同步 store 状态", async () => {
    const timeoutListener = vi.fn();

    const snapshotWithExpiredTimer = createBaseSnapshot("description");
    const endsAt = Date.now() - 1000;
    snapshotWithExpiredTimer.status.phaseTimer = {
      durationSeconds: 60,
      endsAt,
      phase: "description",
    };

    useWhoIsFakerStore.setState({
      snapshot: snapshotWithExpiredTimer,
      privateState: createPrivateState(false, "player_2"),
      phaseTimedOutEndsAt: null,
    });

    render(<FakerPhaseTimerControl onTimeout={timeoutListener} />);

    await waitFor(() => {
      expect(timeoutListener).toHaveBeenCalled();
      expect(useWhoIsFakerStore.getState().phaseTimedOutEndsAt).toBe(endsAt);
    });
  });

  describe("本机时钟不准", () => {
    const renderWithTimer = (endsAt: number, onTimeout: () => void) => {
      const snapshot = createBaseSnapshot("description");
      snapshot.status.phaseTimer = { durationSeconds: 60, endsAt, phase: "description" };
      useWhoIsFakerStore.setState({
        snapshot,
        privateState: createPrivateState(false, "player_2"),
        phaseTimedOutEndsAt: null,
      });
      render(<FakerPhaseTimerControl onTimeout={onTimeout} />);
    };

    afterEach(() => {
      resetClockSample();
    });

    it("本机时钟快 60 秒：服务端时刻还剩 50 秒就不能提前触发超时自动提交", async () => {
      // 样本：本机此刻比服务端快 60 秒。
      recordClockSample(Date.now() - 60_000, Date.now(), Date.now());
      const onTimeout = vi.fn();
      renderWithTimer(Date.now() - 60_000 + 50_000, onTimeout);

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(onTimeout).not.toHaveBeenCalled();
      expect(useWhoIsFakerStore.getState().phaseTimedOutEndsAt).toBeNull();
    });

    it("本机时钟慢 60 秒：服务端时刻已到点就要按时触发，不能拖到本机时钟走完", async () => {
      recordClockSample(Date.now() + 60_000, Date.now(), Date.now());
      const onTimeout = vi.fn();
      // 本机看还有 30 秒，服务端时间轴上已过期 30 秒。
      renderWithTimer(Date.now() + 30_000, onTimeout);

      await waitFor(() => {
        expect(onTimeout).toHaveBeenCalled();
      });
    });
  });
});
