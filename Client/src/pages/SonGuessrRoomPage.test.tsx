import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
    expect(screen.getByText("关联歌曲")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "主题曲" })).toBeInTheDocument();
    expect(screen.getByText("OP")).toBeInTheDocument();
    expect(screen.getByText("测试歌手")).toBeInTheDocument();
    expect(screen.getByText("动作")).toBeInTheDocument();
    expect(screen.getByText("冒险")).toBeInTheDocument();
    expect(screen.queryByText("2024", { selector: "[data-slot='badge']" })).not.toBeInTheDocument();
    expect(screen.queryByText("TV")).not.toBeInTheDocument();
    expect(screen.queryByText("超能力")).not.toBeInTheDocument();
  });

  it("听歌猜番结算曲目类型具体展示（OST、Remix、角色曲）且不展示其它", () => {
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
              id: "song-ost",
              title: "Main Theme",
              artist: "泽野弘之",
              album: "Anime Original Soundtrack",
              audioUrl: "https://audio.example.com/ost.mp3",
              requiresVip: false,
              releaseYear: 2023,
              language: "日语",
              encyclopedia: {
                tags: ["原声集", "热血"],
                aliases: ["主旋律"],
                summary: "动画经典原声音乐。",
              },
            },
            anime: {
              id: "anime-102",
              name: "Anime Title",
              nameCn: "热血动画",
              imageUrl: "https://img.example/anime2.jpg",
              year: 2023,
              rating: 9.0,
              ratingCount: 2000,
              tags: ["战斗", "机甲"],
              metaTags: ["TV"],
            },
            animeTrack: { title: "Main Theme", artist: "泽野弘之", kind: "ost" },
            scores: [],
          },
        }),
      });
    });

    expect(screen.getByText("热血动画")).toBeInTheDocument();
    expect(screen.getByText("关联歌曲")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Main Theme" })).toBeInTheDocument();
    expect(screen.getByText("OST")).toBeInTheDocument();
    expect(screen.getByText(/泽野弘之 · Anime Original Soundtrack/)).toBeInTheDocument();
    expect(screen.getAllByText("2023")).toHaveLength(2);
    expect(screen.getByText("日语")).toBeInTheDocument();
    expect(screen.getByText("原声集")).toBeInTheDocument();
    expect(screen.getByText(/别名：主旋律/)).toBeInTheDocument();
    expect(screen.getByText("动画经典原声音乐。")).toBeInTheDocument();
    expect(screen.queryByText("其它")).not.toBeInTheDocument();
  });

  it("出题设置中不展示歌曲类型筛选按钮", () => {
    renderRoomPage();

    act(() => {
      useSonGuessrStore.setState({
        snapshot: createMockSnapshot({
          settings: {
            ...createMockSnapshot().settings,
            questionType: "anime",
            questionMode: "automatic",
          },
          phase: "waiting",
        }),
      });
    });

    // 展开题目设置手风琴
    const questionSettingsButton = screen.getByRole("button", { name: /题目设置/ });
    act(() => {
      questionSettingsButton.click();
    });

    expect(screen.getByText("番剧筛选")).toBeInTheDocument();
    expect(screen.getByText("年份范围")).toBeInTheDocument();
    expect(screen.getByText("热度范围")).toBeInTheDocument();
    expect(screen.getByText("网易云歌曲热度")).toBeInTheDocument();
    expect(screen.queryByText("歌曲类型")).not.toBeInTheDocument();
  });

  it("竞猜阶段歌词片段与纯音乐展示正确区分", () => {
    renderRoomPage();

    // 1. 开启歌词且有歌词：展示“歌词片段”与歌词行
    act(() => {
      useSonGuessrStore.setState({
        snapshot: createMockSnapshot({
          phase: "playing",
          settings: {
            ...createMockSnapshot().settings,
            showLyrics: true,
          },
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
        privateState: createMockPrivateState({ canGuess: true }),
      });
    });

    expect(screen.getByRole("heading", { name: "歌词片段" })).toBeInTheDocument();
    expect(screen.getByText("夜空中最亮的星")).toBeInTheDocument();

    // 2. 开启歌词但无歌词/纯音乐：展示“音乐片段”与“当前歌曲为纯音乐或无歌词”
    act(() => {
      useSonGuessrStore.setState({
        snapshot: createMockSnapshot({
          phase: "playing",
          settings: {
            ...createMockSnapshot().settings,
            showLyrics: true,
          },
          currentRound: {
            roundNumber: 1,
            submitterPlayerId: "player-1",
            audioUrl: "https://audio.example.com/star.mp3",
            lyricClip: { startTime: 0, endTime: 10_000, lines: [] },
          },
        }),
        privateState: createMockPrivateState({ canGuess: true }),
      });
    });

    expect(screen.getByRole("heading", { name: "音乐片段" })).toBeInTheDocument();
    expect(screen.getByText("当前歌曲为纯音乐或无歌词")).toBeInTheDocument();
    expect(screen.queryByText("本房间未显示歌词提示")).not.toBeInTheDocument();

    // 3. 关闭歌词：展示“音乐片段”与“本房间已关闭歌词提示，请根据音乐进行猜测”
    act(() => {
      useSonGuessrStore.setState({
        snapshot: createMockSnapshot({
          phase: "playing",
          settings: {
            ...createMockSnapshot().settings,
            showLyrics: false,
          },
          currentRound: {
            roundNumber: 1,
            submitterPlayerId: "player-1",
            audioUrl: "https://audio.example.com/star.mp3",
            lyricClip: { startTime: 0, endTime: 10_000, lines: [] },
          },
        }),
        privateState: createMockPrivateState({ canGuess: true }),
      });
    });

    expect(screen.getByRole("heading", { name: "音乐片段" })).toBeInTheDocument();
    expect(screen.getByText("本房间已关闭歌词提示，请根据音乐进行猜测")).toBeInTheDocument();
  });

  it("点击“开始游戏”后按钮进入 loading 禁用状态并展示旋转图标，防止重复提交", async () => {
    let resolveCommand: (val?: unknown) => void = () => {};
    const pendingPromise = new Promise((resolve) => {
      resolveCommand = resolve;
    });
    const sendCommandSpy = vi.fn().mockImplementation(() => pendingPromise);

    useSonGuessrStore.setState({
      sendCommand: sendCommandSpy,
    });

    renderRoomPage();

    const startButton = screen.getByRole("button", { name: "开始游戏" });
    expect(startButton).toBeEnabled();
    expect(screen.queryByTestId("button-spinner")).not.toBeInTheDocument();

    // 点击开始游戏
    fireEvent.click(startButton);

    // 校验请求已发出，按钮进入 loading 禁用态并渲染 spinner 与动态文案
    expect(sendCommandSpy).toHaveBeenCalledWith("song.game.start", {});
    expect(startButton).toBeDisabled();
    expect(startButton).toHaveAttribute("aria-busy", "true");
    expect(within(startButton).getByTestId("button-spinner")).toBeInTheDocument();
    expect(within(startButton).getByText("正在开始游戏...")).toBeInTheDocument();

    // 再次点击被拦截，防止并发重发
    fireEvent.click(startButton);
    expect(sendCommandSpy).toHaveBeenCalledTimes(1);

    // 请求完成响应后解除 loading 态
    await act(async () => {
      resolveCommand({});
    });

    expect(screen.queryByTestId("button-spinner")).not.toBeInTheDocument();
  });

  it("结算阶段点击“再来一轮”后按钮进入 loading 禁用状态且“返回等待阶段”同步禁用，防止并发冲突", async () => {
    let resolveCommand: (val?: unknown) => void = () => {};
    const pendingPromise = new Promise((resolve) => {
      resolveCommand = resolve;
    });
    const sendCommandSpy = vi.fn().mockImplementation(() => pendingPromise);

    useSonGuessrStore.setState({
      sendCommand: sendCommandSpy,
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
          scores: [],
        },
      }),
    });

    renderRoomPage();

    const nextRoundButton = screen.getByRole("button", { name: "再来一轮" });
    const finishButton = screen.getByRole("button", { name: "返回等待阶段" });

    expect(nextRoundButton).toBeEnabled();
    expect(finishButton).toBeEnabled();

    // 点击再来一轮
    fireEvent.click(nextRoundButton);

    expect(sendCommandSpy).toHaveBeenCalledWith("song.game.nextRound", {});
    expect(nextRoundButton).toBeDisabled();
    expect(nextRoundButton).toHaveAttribute("aria-busy", "true");
    expect(within(nextRoundButton).getByTestId("button-spinner")).toBeInTheDocument();
    expect(within(nextRoundButton).getByText("正在准备下一轮...")).toBeInTheDocument();

    // 旁边的返回等待按钮同步禁用，防止阶段跳转冲突
    expect(finishButton).toBeDisabled();

    // 再次点击被拦截
    fireEvent.click(nextRoundButton);
    expect(sendCommandSpy).toHaveBeenCalledTimes(1);

    // 请求完成
    await act(async () => {
      resolveCommand({});
    });

    expect(within(nextRoundButton).queryByTestId("button-spinner")).not.toBeInTheDocument();
  });
});
