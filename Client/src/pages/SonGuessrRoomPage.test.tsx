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
      correctGuesses: 0,
      totalGuesses: 0,
      guessesUsed: 0,
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
      correctGuesses: 0,
      totalGuesses: 0,
      guessesUsed: 0,
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
            submitterPlayerId: "player-1",
            audioUrl: "https://audio.example.com/star.mp3",
            lyricClip: {
              startTime: 10_000,
              endTime: 15_000,
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
            submitterPlayerId: "player-1",
            correctPlayerIds: ["player-1"],
            attempts: [],
            song: {
              id: "song-101",
              title: "夜空中最亮的星",
              artist: "逃跑计划",
              album: "世界",
              audioUrl: "https://audio.example.com/star.mp3",
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
                correctGuesses: 1,
                totalGuesses: 1,
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
            submitterPlayerId: "player-1",
            audioUrl: "https://audio.example.com/star.mp3",
            lyricClip: {
              startTime: 0,
              endTime: 5_000,
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
              correctGuesses: 1,
              totalGuesses: 1,
              guessesUsed: 1,
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
              correctGuesses: 0,
              totalGuesses: 0,
              guessesUsed: 0,
            },
          ],
          currentRound: {
            roundNumber: 1,
            submitterPlayerId: "player-1",
            audioUrl: "https://audio.example.com/star.mp3",
            lyricClip: {
              startTime: 0,
              endTime: 5_000,
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
            submitterPlayerId: "player-1",
            audioUrl: "https://audio.example.com/star.mp3",
            lyricClip: { startTime: 0, endTime: 0, lines: [] },
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

  it("结算阶段保持简洁无控制按钮，且全局单例 audio 禁用原生 autoplay", () => {
    const { container } = renderRoomPage();

    act(() => {
      useSonGuessrStore.setState({
        snapshot: createMockSnapshot({
          phase: "roundResult",
          roundNumber: 1,
          roundSummary: {
            roundNumber: 1,
            submitterPlayerId: "player-1",
            correctPlayerIds: ["player-1"],
            attempts: [],
            song: {
              id: "song-101",
              title: "夜空中最亮的星",
              artist: "逃跑计划",
              album: "世界",
              audioUrl: "https://audio.example.com/star.mp3",
              durationMs: 250_000,
              requiresVip: false,
              chorus: { startTime: 65_000, endTime: 90_000 },
              encyclopedia: { tags: ["流行"] },
            },
            scores: [],
          },
        }),
      });
    });

    // 验证结算卡片展示歌曲信息
    expect(screen.getByRole("heading", { name: "答案揭晓" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "夜空中最亮的星" })).toBeInTheDocument();

    // 验证副歌时间徽章与手动播放/重播副歌按钮不存在
    expect(screen.queryByText(/副歌/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /播放副歌|暂停副歌|重播副歌/ })).not.toBeInTheDocument();

    // 验证 audio 节点存在且未设置原生 autoPlay 属性，防止切台自动从头大音量播放
    const audio = container.querySelector("audio");
    expect(audio).toBeInTheDocument();
    expect(audio).not.toHaveAttribute("autoplay");
  });

  it("听歌猜番结算展示关联歌曲、曲目类型和过滤后的作品标签", () => {
    renderRoomPage();

    act(() => {
      useSonGuessrStore.setState({
        snapshot: createMockSnapshot({
          settings: {
            ...createMockSnapshot().settings,
            questionType: "anime",
          },
          phase: "roundResult",
          roundNumber: 1,
          roundSummary: {
            roundNumber: 1,
            submitterPlayerId: "player-1",
            correctPlayerIds: ["player-1"],
            attempts: [],
            song: {
              id: "song-101",
              title: "主题曲",
              artist: "测试歌手",
              audioUrl: "https://audio.example.com/theme.mp3",
              requiresVip: false,
              encyclopedia: { tags: [] },
            },
            anime: {
              id: "anime-101",
              name: "Anime Original",
              nameCn: "番剧中文名",
              imageUrl: "https://img.example/anime.jpg",
              year: 2024,
              rating: 8.8,
              ratingCount: 1000,
              tags: ["动作", "奇幻", "2024", "电视", "冒险", "校园", "超能力"],
              metaTags: ["TV"],
            },
            animeTrack: { title: "主题曲", artist: "测试歌手", kind: "opening" },
            scores: [],
          },
        }),
      });
    });

    expect(screen.getByText("番剧中文名")).toBeInTheDocument();
    expect(screen.getByText(/关联歌曲：主题曲 · 测试歌手 · OP/)).toBeInTheDocument();
    expect(screen.getByText("动作")).toBeInTheDocument();
    expect(screen.getByText("冒险")).toBeInTheDocument();
    expect(screen.queryByText("2024", { selector: "[data-slot='badge']" })).not.toBeInTheDocument();
    expect(screen.queryByText("TV")).not.toBeInTheDocument();
    expect(screen.queryByText("超能力")).not.toBeInTheDocument();
  });
});
