import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrivateState, RoomSnapshot } from "@/types";
import { useWhoIsFakerStore as useGameStore } from "@/stores/UseWhoIsFakerStore";
import { DescriptionPhase } from "./DescriptionPhase";

const snapshot: RoomSnapshot = {
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
    phase: "description",
    speechMode: "normal",
    started: true,
    day: 1,
    questionerPlayerId: "host_1",
    descriptionOrder: ["player_2", "player_3"],
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
      name: "玩家2",
      score: 0,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "alive",
    },
    {
      id: "player_3",
      name: "玩家3",
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
};

const privateState: PrivateState = {
  playerId: "player_2",
  sessionToken: "session_token",
  isQuestioner: false,
  canSubmitBlankGuess: false,
  blankGuessUsed: false,
  nightActionSubmitted: false,
};

describe("DescriptionPhase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("当收到 whoisfaker:phase-timeout 事件且输入框有内容时，自动提交发言", async () => {
    const sendCommandMock = vi.fn().mockResolvedValue({});
    useGameStore.setState({
      snapshot,
      privateState,
      sendCommand: sendCommandMock,
    });

    render(<DescriptionPhase />);

    const input = screen.getByPlaceholderText("输入你的描述...");
    fireEvent.change(input, { target: { value: "我的词语是红色的" } });

    // 触发阶段超时事件
    window.dispatchEvent(new CustomEvent("whoisfaker:phase-timeout"));

    await waitFor(() => {
      expect(sendCommandMock).toHaveBeenCalledWith("game.submitDescription", {
        text: "我的词语是红色的",
      });
    });
  });
});
