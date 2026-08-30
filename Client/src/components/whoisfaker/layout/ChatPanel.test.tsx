import { render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { ChatPanel } from "./ChatPanel";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import type { RoomSnapshot, PrivateState } from "@/types";

const mockSnapshot: RoomSnapshot = {
  roomId: "1234",
  name: "测试房间",
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  hostPlayerId: "p1",
  testMode: false,
  roleLimits: { maxUndercoverCount: 1, canEnableAngel: false, canEnableBlank: false },
  settings: { roleConfig: { undercoverCount: 1, hasAngel: false, hasBlank: false } },
  status: {
    phase: "description",
    started: true,
    day: 1,
  },
  players: [
    {
      id: "p1",
      name: "活人玩家",
      score: 0,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: true,
      roundStatus: "alive",
    },
    {
      id: "p2",
      name: "淘汰玩家",
      score: 0,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "dead",
    },
    {
      id: "p3",
      name: "旁观玩家",
      score: 0,
      membership: "spectator",
      online: true,
      isReady: false,
      isBot: false,
      isHost: false,
      roundStatus: "spectator",
    },
  ],
  descriptions: [],
  chat: [
    {
      id: "msg-1",
      playerId: "p1",
      playerName: "活人玩家",
      text: "大家好，这是活人发言",
      createdAt: 1000,
      system: false,
      channel: "main",
    },
    {
      id: "msg-2",
      playerId: "p2",
      playerName: "淘汰玩家",
      text: "这是亡者频道的发言",
      createdAt: 2000,
      system: false,
      channel: "ghost",
      ghostRole: "dead",
    },
    {
      id: "msg-3",
      playerId: "system",
      playerName: "系统",
      text: "已进入观战频道，发言仅对淘汰玩家与观战者可见",
      createdAt: 2500,
      system: true,
      channel: "ghost",
    },
  ],
};

const mockPrivateState: PrivateState = {
  playerId: "p2",
  sessionToken: "token-p2",
  isQuestioner: false,
  canSubmitBlankGuess: false,
  blankGuessUsed: false,
  nightActionSubmitted: false,
};

describe("ChatPanel Component", () => {
  beforeEach(() => {
    useWhoIsFakerStore.setState({
      snapshot: mockSnapshot,
      privateState: mockPrivateState,
    });
  });

  it("renders messages and applies ghost styles for ghost messages", () => {
    render(<ChatPanel />);

    expect(screen.getByText("活人玩家")).toBeInTheDocument();
    expect(screen.getByText("淘汰玩家")).toBeInTheDocument();
    expect(screen.getByText("大家好，这是活人发言")).toBeInTheDocument();
    expect(screen.getByText("这是亡者频道的发言")).toBeInTheDocument();

    // 观战/亡者消息带有虚线边框样式
    const deadMsgBubble = screen.getByText("这是亡者频道的发言").closest("div");
    expect(deadMsgBubble).toHaveClass("border-dashed");
  });

  it("uses standard placeholder and enters spectate channel notice", () => {
    render(<ChatPanel />);

    expect(screen.getByPlaceholderText("请输入文本")).toBeInTheDocument();
    expect(
      screen.getByText("已进入观战频道，发言仅对淘汰玩家与观战者可见"),
    ).toBeInTheDocument();
  });

  it("switches to main channel when in waiting phase", async () => {
    const waitingSnapshot: RoomSnapshot = {
      ...mockSnapshot,
      status: {
        phase: "waiting",
        started: false,
        day: 0,
      },
    };

    useWhoIsFakerStore.setState({
      snapshot: waitingSnapshot,
      privateState: mockPrivateState,
    });

    render(<ChatPanel />);

    expect(screen.getByPlaceholderText("请输入文本")).toBeInTheDocument();
  });
});
