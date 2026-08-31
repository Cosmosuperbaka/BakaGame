import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrivateState, RoomSnapshot } from "@/types";
import { useWhoIsFakerStore as useGameStore } from "@/stores/UseWhoIsFakerStore";
import { PhaseTimerControl } from "./PhaseTimerControl";

const createBaseSnapshot = (phase: RoomSnapshot["status"]["phase"] = "description"): RoomSnapshot => ({
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

const createPrivateState = (isQuestioner = true, playerId = "host_1"): PrivateState => ({
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
    useGameStore.setState({
      snapshot: createBaseSnapshot("waiting"),
      privateState: createPrivateState(true, "host_1"),
    });
    const { container, rerender } = render(<PhaseTimerControl />);
    expect(container.firstChild).toBeNull();

    // 2. 选择出题人阶段（房主）
    useGameStore.setState({
      snapshot: createBaseSnapshot("assigningQuestioner"),
      privateState: createPrivateState(false, "host_1"),
    });
    rerender(<PhaseTimerControl />);
    expect(container.firstChild).toBeNull();

    // 3. 出题阶段（主持人）
    useGameStore.setState({
      snapshot: createBaseSnapshot("wordSubmission"),
      privateState: createPrivateState(true, "host_1"),
    });
    rerender(<PhaseTimerControl />);
    expect(container.firstChild).toBeNull();

    // 4. 描述阶段（普通玩家）
    useGameStore.setState({
      snapshot: createBaseSnapshot("description"),
      privateState: createPrivateState(false, "player_2"),
    });
    rerender(<PhaseTimerControl />);
    expect(container.firstChild).toBeNull();
  });

  it("支持的阶段中，主持人可以看到 1/2/3 分钟选择器并发送开启倒计时指令", async () => {
    const sendCommandMock = vi.fn().mockResolvedValue({});
    useGameStore.setState({
      snapshot: createBaseSnapshot("description"),
      privateState: createPrivateState(true, "host_1"),
      sendCommand: sendCommandMock,
    });

    render(<PhaseTimerControl />);

    expect(screen.getByTestId("host-timer-bar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1分钟" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2分钟" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3分钟" })).toBeInTheDocument();

    // 切换为 2 分钟并点击开启
    fireEvent.click(screen.getByRole("button", { name: "2分钟" }));
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

    useGameStore.setState({
      snapshot: snapshotWithTimer,
      privateState: createPrivateState(true, "host_1"),
      sendCommand: sendCommandMock,
    });

    render(<PhaseTimerControl />);

    expect(screen.getByText("本阶段倒计时")).toBeInTheDocument();
    const cancelButton = screen.getByRole("button", { name: /取消/ });
    expect(cancelButton).toBeInTheDocument();

    fireEvent.click(cancelButton);
    await waitFor(() => {
      expect(sendCommandMock).toHaveBeenCalledWith("game.stopPhaseTimer", {});
    });
  });

  it("倒计时归零时广播 whoisfaker:phase-timeout 事件", async () => {
    const timeoutListener = vi.fn();
    window.addEventListener("whoisfaker:phase-timeout", timeoutListener);

    const snapshotWithExpiredTimer = createBaseSnapshot("description");
    snapshotWithExpiredTimer.status.phaseTimer = {
      durationSeconds: 60,
      endsAt: Date.now() - 1000, // 已超时
      phase: "description",
    };

    useGameStore.setState({
      snapshot: snapshotWithExpiredTimer,
      privateState: createPrivateState(false, "player_2"),
    });

    render(<PhaseTimerControl />);

    await waitFor(() => {
      expect(timeoutListener).toHaveBeenCalled();
    });

    window.removeEventListener("whoisfaker:phase-timeout", timeoutListener);
  });
});
