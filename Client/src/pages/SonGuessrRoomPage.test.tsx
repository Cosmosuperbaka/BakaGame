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

import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import type {
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
} from "@/types";
import SonGuessrRoomPage from "./SonGuessrRoomPage";

const initialStoreState = useSonGuessrStore.getState();

const createMockSnapshot = (
  overrides: Partial<SonGuessrRoomSnapshot> = {},
): SonGuessrRoomSnapshot => ({
  roomId: "TEST_ROOM",
  name: "猜歌测试房",
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
  maxPlayers: 16,
  testMode: false,
  musicAccountReady: true,
  hostPlayerId: "player-1",
  settings: {
    questionType: "song",
    questionMode: "manual",
    autoRotateSubmitter: false,
    autoFilters: { artists: [], minPopularity: 0 },
    lyricsLineCount: 4,
    showLyrics: true,
    bloodMode: false,
    maxGuessesPerRound: 5,
    guessDurationSeconds: 60,
    showGuessTimer: true,
  },
  phase: "waiting",
  roundNumber: 0,
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
  ],
  chat: [],
  ...overrides,
});

const createMockPrivateState = (
  overrides: Partial<SonGuessrPrivateState> = {},
): SonGuessrPrivateState => ({
  playerId: "player-1",
  sessionToken: "token-1",
  isSubmitter: false,
  canSubmitSong: false,
  canGuess: false,
  canGiveUp: false,
  remainingGuesses: 5,
  visibleAttempts: [],
  ...overrides,
});

function renderRoomPage(roomId = "TEST_ROOM") {
  return render(
    <MemoryRouter initialEntries={[`/songuessr/room/${roomId}`]}>
      <Routes>
        <Route path="/songuessr/room/:roomId" element={<SonGuessrRoomPage />} />
        <Route path="/songuessr" element={<div>Songuessr 游戏大厅</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SonGuessrRoomPage 页面级集成测试", () => {
  beforeEach(() => {
    window.HTMLMediaElement.prototype.load = vi.fn();
    window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    window.HTMLMediaElement.prototype.pause = vi.fn();

    useSonGuessrStore.setState({
      ...initialStoreState,
      roomId: "TEST_ROOM",
      connected: true,
      snapshot: createMockSnapshot(),
      privateState: createMockPrivateState(),
    });
  });

  afterEach(() => {
    useSonGuessrStore.setState(initialStoreState, true);
    vi.restoreAllMocks();
  });

  it("渲染等待阶段完整快照（房间名、房主控制区、规则配置与玩家列表）", () => {
    renderRoomPage();

    // 房间名与房间号展示
    expect(screen.getByText("猜歌测试房")).toBeInTheDocument();
    expect(screen.getByText("#TEST_ROOM")).toBeInTheDocument();

    // 房主控制面板与开始按钮
    expect(screen.getByRole("heading", { name: "等待玩家加入" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始游戏" })).toBeInTheDocument();

    // 规则配置折叠面板
    expect(screen.getByText("题目设置")).toBeInTheDocument();
    expect(screen.getByText("猜测设置")).toBeInTheDocument();
    expect(screen.getByText("房间设置")).toBeInTheDocument();

    // 玩家列表
    expect(screen.getByText("房主小明")).toBeInTheDocument();
    expect(screen.getByText("玩家小红")).toBeInTheDocument();
  });

  it("真实状态驱动阶段流转：选歌 -> 猜歌 -> 答案揭晓", () => {
    renderRoomPage();

    // 1. 流转至选歌阶段 (submittingSong)
    act(() => {
      useSonGuessrStore.setState({
        snapshot: createMockSnapshot({
          phase: "submittingSong",
          pendingSubmitterPlayerId: "player-1",
        }),
        privateState: createMockPrivateState({
          isSubmitter: true,
          canSubmitSong: true,
        }),
      });
    });

    expect(screen.getByRole("heading", { name: "轮到你出题" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择歌曲" })).toBeInTheDocument();

    // 2. 流转至猜歌阶段 (playing)
    act(() => {
      useSonGuessrStore.setState({
        snapshot: createMockSnapshot({
          phase: "playing",
          roundNumber: 1,
          currentRound: {
            roundNumber: 1,
            audioUrl: "https://audio.example.com/star.mp3",
            lyricClip: {
              startTime: 10_000,
              lines: [{ time: 10_000, endTime: 15_000, text: "夜空中最亮的星" }],
            },
          },
        }),
        privateState: createMockPrivateState({
          canGuess: true,
          remainingGuesses: 4,
        }),
      });
    });

    expect(screen.getByRole("heading", { name: "听歌猜曲" })).toBeInTheDocument();
    expect(screen.getByText("夜空中最亮的星")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /提交猜测（剩余 4 次）/ })).toBeInTheDocument();

    // 3. 流转至答案揭晓结算阶段 (roundResult)
    act(() => {
      useSonGuessrStore.setState({
        snapshot: createMockSnapshot({
          phase: "roundResult",
          roundNumber: 1,
          roundSummary: {
            roundNumber: 1,
            song: {
              id: "song-101",
              title: "夜空中最亮的星",
              artist: "逃跑计划",
              album: "世界",
              audioUrl: "https://audio.example.com/star.mp3",
              lyrics: [],
              durationMs: 250_000,
              requiresVip: false,
              encyclopedia: {
                tags: ["流行", "摇滚"],
              },
            },
            scores: [
              {
                playerId: "player-1",
                playerName: "房主小明",
                score: 13,
                delta: 3,
                isSubmitter: false,
                correct: true,
              },
            ],
          },
        }),
      });
    });

    expect(screen.getByRole("heading", { name: "答案揭晓" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "夜空中最亮的星" })).toBeInTheDocument();
    expect(screen.getByText(/逃跑计划/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再来一轮" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回等待阶段" })).toBeInTheDocument();
  });

  it("猜歌互动：打开猜测弹窗并展示反馈结果与得分更新", () => {
    renderRoomPage();

    act(() => {
      useSonGuessrStore.setState({
        snapshot: createMockSnapshot({
          phase: "playing",
          roundNumber: 1,
          currentRound: {
            roundNumber: 1,
            audioUrl: "https://audio.example.com/star.mp3",
            lyricClip: {
              startTime: 0,
              lines: [{ time: 0, endTime: 5_000, text: "夜空中最亮的星" }],
            },
          },
        }),
        privateState: createMockPrivateState({
          canGuess: true,
          remainingGuesses: 3,
          visibleAttempts: [],
        }),
      });
    });

    const guessButton = screen.getByRole("button", { name: /提交猜测（剩余 3 次）/ });
    fireEvent.click(guessButton);

    // 弹出搜歌/猜歌对话框
    expect(screen.getByText("提交你的猜测")).toBeInTheDocument();

    // 玩家猜对后服务端推送更新快照与私有状态
    act(() => {
      useSonGuessrStore.setState({
        snapshot: createMockSnapshot({
          phase: "playing",
          roundNumber: 1,
          players: [
            {
              id: "player-1",
              name: "房主小明",
              score: 15, // 得分从 10 增加到 15
              membership: "active",
              online: true,
              isReady: true,
              isBot: false,
              isHost: true,
              roundStatus: "correct",
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
          ],
          currentRound: {
            roundNumber: 1,
            audioUrl: "https://audio.example.com/star.mp3",
            lyricClip: {
              startTime: 0,
              lines: [{ time: 0, endTime: 5_000, text: "夜空中最亮的星" }],
            },
          },
        }),
        privateState: createMockPrivateState({
          canGuess: false,
          remainingGuesses: 2,
          visibleAttempts: [
            {
              id: "att-1",
              playerId: "player-1",
              playerName: "房主小明",
              guessNumber: 1,
              createdAt: Date.now(),
              guessedSong: { id: "s1", title: "夜空中最亮的星", artist: "逃跑计划" },
              result: "correct",
            },
          ],
        }),
      });
    });

    // 验证猜中状态与更新后的得分
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getByText("猜中")).toBeInTheDocument();
    expect(screen.getByText("本轮操作已完成")).toBeInTheDocument();
    expect(screen.getByText(/夜空中最亮的星 · 逃跑计划/)).toBeInTheDocument();
  });

  it("非 waiting 阶段自动保存严格被抑制阻断", () => {
    const sendCommandSpy = vi.fn().mockResolvedValue({});
    useSonGuessrStore.setState({
      sendCommand: sendCommandSpy,
    });

    renderRoomPage();

    // 切换到 playing 阶段
    act(() => {
      useSonGuessrStore.setState({
        snapshot: createMockSnapshot({
          phase: "playing",
          currentRound: {
            roundNumber: 1,
            audioUrl: "https://audio.example.com/star.mp3",
            lyricClip: { startTime: 0, lines: [] },
          },
        }),
        privateState: createMockPrivateState({ canGuess: true }),
      });
    });

    // 在非 waiting 阶段，updateSettings 指令绝对不会被触发
    const updateSettingsCalls = sendCommandSpy.mock.calls.filter(
      (call) => call[0] === "song.room.updateSettings",
    );
    expect(updateSettingsCalls).toHaveLength(0);
  });

  it("断线状态展示与房间被关闭自动退出到大厅", () => {
    renderRoomPage();

    // 1. 断线状态下展示提示
    act(() => {
      useSonGuessrStore.setState({ connected: false });
    });
    expect(screen.getByText("断线中...")).toBeInTheDocument();

    // 2. 房间被服务端关闭时，页面自动重定向到 /songuessr 大厅
    act(() => {
      useSonGuessrStore.setState({ roomClosedAt: Date.now() });
    });
    expect(screen.getByText("Songuessr 游戏大厅")).toBeInTheDocument();
  });
});
