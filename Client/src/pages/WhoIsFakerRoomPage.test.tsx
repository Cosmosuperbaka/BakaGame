import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import type { PrivateState, RoomSnapshot } from "@/types";
import WhoIsFakerRoomPage from "./WhoIsFakerRoomPage";

const initialStoreState = useWhoIsFakerStore.getState();

const createMockSnapshot = (overrides: Partial<RoomSnapshot> = {}): RoomSnapshot => ({
  roomId: "FAKER_ROOM",
  name: "卧底测试房",
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  hostPlayerId: "player-1",
  testMode: false,
  roleLimits: {
    maxUndercoverCount: 2,
    canEnableAngel: true,
    canEnableBlank: true,
  },
  settings: {
    roleConfig: {
      undercoverCount: 1,
      hasAngel: false,
      hasBlank: true,
    },
  },
  status: {
    phase: "waiting",
    roundId: "round-100",
    started: false,
    day: 0,
  },
  players: [
    {
      id: "player-1",
      name: "房主小明",
      score: 10,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: true,
      roundStatus: "waiting",
    },
    {
      id: "player-2",
      name: "玩家小红",
      score: 5,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "waiting",
    },
    {
      id: "player-3",
      name: "玩家小强",
      score: 8,
      membership: "active",
      online: true,
      isReady: true,
      isBot: false,
      isHost: false,
      roundStatus: "waiting",
    },
  ],
  descriptions: [],
  chat: [],
  ...overrides,
});

const createMockPrivateState = (
  overrides: Partial<PrivateState> = {},
): PrivateState => ({
  playerId: "player-1",
  sessionToken: "token-1",
  isQuestioner: false,
  canSubmitBlankGuess: false,
  blankGuessUsed: false,
  nightActionSubmitted: false,
  ...overrides,
});

function renderRoomPage(roomId = "FAKER_ROOM") {
  return render(
    <MemoryRouter initialEntries={[`/whoisfaker/room/${roomId}`]}>
      <Routes>
        <Route path="/whoisfaker/room/:roomId" element={<WhoIsFakerRoomPage />} />
        <Route path="/whoisfaker" element={<div>WhoIsFaker 游戏大厅</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WhoIsFakerRoomPage 页面级集成测试", () => {
  beforeEach(() => {
    useWhoIsFakerStore.setState({
      ...initialStoreState,
      roomId: "FAKER_ROOM",
      connected: true,
      snapshot: createMockSnapshot(),
      privateState: createMockPrivateState(),
    });
  });

  afterEach(() => {
    useWhoIsFakerStore.setState(initialStoreState, true);
    vi.restoreAllMocks();
  });

  it("渲染等待阶段完整快照（房间名、房主控制区、规则配置与玩家列表）", () => {
    renderRoomPage();

    // 房间名与房间号
    expect(screen.getByText("卧底测试房")).toBeInTheDocument();
    expect(screen.getByText("#FAKER_ROOM")).toBeInTheDocument();

    // 房主控制区
    expect(screen.getByRole("button", { name: "开始游戏" })).toBeInTheDocument();
    expect(screen.getByText("房间设置")).toBeInTheDocument();

    // 玩家列表与准备状态徽章
    expect(screen.getByText("房主小明")).toBeInTheDocument();
    expect(screen.getByText("玩家小红")).toBeInTheDocument();
    expect(screen.getByText("玩家小强")).toBeInTheDocument();
    expect(screen.getAllByText("准备").length).toBeGreaterThanOrEqual(1);
  });

  it("发言阶段流转、发言记录呈现与投票面板交互", () => {
    const sendCommandSpy = vi.fn().mockResolvedValue({});
    useWhoIsFakerStore.setState({
      sendCommand: sendCommandSpy,
    });

    renderRoomPage();

    // 1. 流转到描述发言阶段
    act(() => {
      useWhoIsFakerStore.setState({
        snapshot: createMockSnapshot({
          status: {
            phase: "description",
            roundId: "round-100",
            started: true,
            day: 1,
            speechOrder: ["player-2", "player-3", "player-1"],
          },
          players: [
            {
              id: "player-1",
              name: "房主小明",
              score: 10,
              membership: "active",
              online: true,
              isReady: true,
              isBot: false,
              isHost: true,
              roundStatus: "alive",
            },
            {
              id: "player-2",
              name: "玩家小红",
              score: 5,
              membership: "active",
              online: true,
              isReady: true,
              isBot: false,
              isHost: false,
              roundStatus: "alive",
            },
            {
              id: "player-3",
              name: "玩家小强",
              score: 8,
              membership: "active",
              online: true,
              isReady: true,
              isBot: false,
              isHost: false,
              roundStatus: "alive",
            },
          ],
          descriptions: [
            {
              id: "desc-1",
              kind: "description",
              cycle: 1,
              playerId: "player-2",
              playerName: "玩家小红",
              text: "这个东西是圆形的",
              createdAt: Date.now(),
            },
          ],
        }),
        privateState: createMockPrivateState({
          word: "西瓜",
        }),
      });
    });

    expect(screen.getByText("第 1 天")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "描述阶段" })).toBeInTheDocument();
    expect(screen.getByText("这个东西是圆形的")).toBeInTheDocument();

    // 2. 流转到投票阶段
    act(() => {
      useWhoIsFakerStore.setState({
        snapshot: createMockSnapshot({
          status: {
            phase: "voting",
            roundId: "round-100",
            started: true,
            day: 1,
          },
          players: [
            {
              id: "player-1",
              name: "房主小明",
              score: 10,
              membership: "active",
              online: true,
              isReady: true,
              isBot: false,
              isHost: true,
              roundStatus: "alive",
            },
            {
              id: "player-2",
              name: "玩家小红",
              score: 5,
              membership: "active",
              online: true,
              isReady: true,
              isBot: false,
              isHost: false,
              roundStatus: "alive",
            },
            {
              id: "player-3",
              name: "玩家小强",
              score: 8,
              membership: "active",
              online: true,
              isReady: true,
              isBot: false,
              isHost: false,
              roundStatus: "alive",
            },
          ],
        }),
        privateState: createMockPrivateState({
          myCurrentVoteTargetId: undefined,
        }),
      });
    });

    expect(screen.getByRole("heading", { name: "投票阶段" })).toBeInTheDocument();

    // 找到可投玩家并点击投票
    const voteButton = screen.getByRole("button", { name: "玩家小红" });
    fireEvent.click(voteButton);

    expect(sendCommandSpy).toHaveBeenCalledWith("game.submitVote", { targetId: "player-2" });
  });

  it("结算弹框展示：卧底胜利、词语揭秘全景与胜负原因", () => {
    renderRoomPage();

    act(() => {
      useWhoIsFakerStore.setState({
        snapshot: createMockSnapshot({
          status: {
            phase: "gameOver",
            roundId: "round-100",
            started: true,
            day: 2,
          },
          summary: {
            winner: "undercover",
            reason: "卧底成功隐藏到最后，获得胜利",
            awardedScores: [
              { playerId: "player-2", delta: 3 },
            ],
            revealedRoles: [
              { playerId: "player-1", role: "civilian" },
              { playerId: "player-2", role: "undercover" },
              { playerId: "player-3", role: "civilian" },
            ],
            descriptions: [],
            blankGuesses: [],
            words: {
              pair: ["西瓜", "冬瓜"],
              civilianWord: "西瓜",
              undercoverWord: "冬瓜",
            },
          },
        }),
      });
    });

    // 获胜标题与解密词语
    expect(screen.getByRole("heading", { name: "卧底阵营胜利" })).toBeInTheDocument();
    expect(screen.getByText("本局词语解密")).toBeInTheDocument();
    expect(screen.getByText("西瓜")).toBeInTheDocument();
    expect(screen.getByText("冬瓜")).toBeInTheDocument();
    expect(screen.getByText("身份揭示与得分统计")).toBeInTheDocument();
  });

  it("白板胜利结算与词语提示展示", () => {
    renderRoomPage();

    act(() => {
      useWhoIsFakerStore.setState({
        snapshot: createMockSnapshot({
          status: {
            phase: "gameOver",
            roundId: "round-100",
            started: true,
            day: 1,
          },
          summary: {
            winner: "blank",
            reason: "白板成功猜对词语，获得胜利",
            awardedScores: [],
            revealedRoles: [
              { playerId: "player-1", role: "civilian" },
              { playerId: "player-2", role: "blank" },
            ],
            descriptions: [],
            blankGuesses: [],
            words: {
              pair: ["电脑", "平板"],
              civilianWord: "电脑",
              undercoverWord: "平板",
              blankHint: "电子设备",
            },
          },
        }),
      });
    });

    expect(screen.getByRole("heading", { name: "白板胜利" })).toBeInTheDocument();
    expect(screen.getByText("电脑")).toBeInTheDocument();
    expect(screen.getByText("平板")).toBeInTheDocument();
    expect(screen.getByText("电子设备")).toBeInTheDocument();
  });

  it("长连接断线状态展示与房间被关闭自动退出到大厅", () => {
    renderRoomPage();

    // 1. 断线状态下展示提示
    act(() => {
      useWhoIsFakerStore.setState({ connected: false });
    });
    expect(screen.getByText("断线中...")).toBeInTheDocument();

    // 2. 房间被服务端关闭时，页面自动重定向到 /whoisfaker 大厅
    act(() => {
      useWhoIsFakerStore.setState({ roomClosedAt: Date.now() });
    });
    expect(screen.getByText("WhoIsFaker 游戏大厅")).toBeInTheDocument();
  });
});
