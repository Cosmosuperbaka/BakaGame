import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 页面测试验证房间状态与无障碍歌词文本；真实排版与媒体演出由歌词浏览器回归覆盖。
vi.mock("@/components/songuessr/lyrics/SongLyricScene", () => ({
  SongLyricScene: class {
    setSource() {}
    setPlayback() {}
    dispose() {}
  },
}));

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
const mediaMethods = ["load", "play", "pause"] as const;
const originalMediaDescriptors = new Map(
  mediaMethods.map((method) => [method, Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, method)]),
);

const createMockSnapshot = (
  overrides: Partial<SonGuessrRoomSnapshot> = {},
): SonGuessrRoomSnapshot => ({
  roomId: "TEST_ROOM",
  name: "猜歌测试房",
  solo: false,
  visibility: "public",
  allowSpectators: true,
  hasPassword: false,
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

function renderSoloPage() {
  return render(
    <MemoryRouter initialEntries={["/songuessr/solo"]}>
      <Routes>
        <Route path="/songuessr/solo" element={<SonGuessrRoomPage solo />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SonGuessrRoomPage 页面级集成测试", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    useSonGuessrStore.setState({
      ...initialStoreState,
      roomId: "TEST_ROOM",
      connected: true,
      snapshot: createMockSnapshot(),
      privateState: createMockPrivateState(),
    });
  });

  afterEach(() => {
    try {
      // 先卸载真实组件，避免清理媒体或待提交草稿时调用已恢复的真实动作。
      cleanup();
    } finally {
      useSonGuessrStore.setState(initialStoreState, true);
      window.sessionStorage.removeItem("songuessr_solo_room");
      vi.restoreAllMocks();
      vi.useRealTimers();
    }

    for (const method of mediaMethods) {
      expect(Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, method)).toEqual(
        originalMediaDescriptors.get(method),
      );
    }
    expect(useSonGuessrStore.getState()).toBe(initialStoreState);
    expect(useSonGuessrStore.getState().sendCommand).toBe(initialStoreState.sendCommand);
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

  it("单人模式隐藏玩家栏与聊天栏，只保留自动出题与开始入口", () => {
    // 预置单人房间号，让页面直接命中已入房状态，避免触发建房流程。
    window.sessionStorage.setItem("songuessr_solo_room", "4321");
    useSonGuessrStore.setState({
      roomId: "4321",
      snapshot: createMockSnapshot({
        roomId: "4321",
        solo: true,
        players: [createMockSnapshot().players[0]],
      }),
      privateState: createMockPrivateState(),
    });
    renderSoloPage();

    expect(screen.getByRole("heading", { name: "准备开始" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始游戏" })).toBeInTheDocument();

    // 房间设置、出题方式、玩家栏与聊天入口在单人模式下全部移除
    expect(screen.queryByText("房间设置")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "手动出题" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "自动出题" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("玩家列表")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("聊天")).not.toBeInTheDocument();
    expect(screen.queryByText("房主小明")).not.toBeInTheDocument();
  });

  it("单人模式结算按答对轮数与已进行轮数统计", () => {
    window.sessionStorage.setItem("songuessr_solo_room", "4321");
    useSonGuessrStore.setState({
      roomId: "4321",
      snapshot: createMockSnapshot({
        roomId: "4321",
        solo: true,
        phase: "roundResult",
        roundNumber: 2,
        players: [{ ...createMockSnapshot().players[0], correctGuesses: 1, totalGuesses: 3 }],
        roundSummary: {
          roundNumber: 2,
          submitterPlayerId: "",
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
            encyclopedia: { tags: ["流行", "摇滚"] },
          },
          scores: [
            {
              playerId: "player-1",
              playerName: "房主小明",
              score: 11,
              delta: 1,
              correctGuesses: 1,
              totalGuesses: 3,
            },
          ],
        },
      }),
      privateState: createMockPrivateState(),
    });
    renderSoloPage();

    // 分母是已进行轮数而不是猜测次数：两轮里答对一轮即 1/2。
    expect(screen.getByTestId("solo-correct-rounds").textContent).toBe("答对 1/2 轮");
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
    // 出题人直接看到搜索框，不再先点一个按钮展开。
    expect(screen.getByRole("combobox", { name: "搜索歌曲" })).toBeEnabled();

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
    expect(screen.getByTestId("baka-song-lyric-container")).toHaveTextContent("夜空中最亮的星");
    expect(screen.getByRole("region", { name: "提交猜测" })).toHaveTextContent("剩余 4 次猜测");
    // 搜索栏独立于歌词卡，放在歌词容器之外。
    expect(screen.getByTestId("baka-song-lyric-container")).not.toContainElement(screen.getByRole("combobox", { name: "搜索歌曲" }));

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

  it("猜歌互动：猜测栏常驻并展示反馈结果与得分更新", () => {
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

    // 猜测栏常驻在歌词卡下方：搜索框可用，次数与投降按钮同在一栏。
    const guessBar = screen.getByRole("region", { name: "提交猜测" });
    expect(guessBar).toHaveTextContent("剩余 3 次猜测");
    expect(within(guessBar).getByRole("combobox", { name: "搜索歌曲" })).toBeEnabled();

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
    expect(screen.getByText("猜中了，等待其他玩家")).toBeInTheDocument();
    expect(screen.getByText(/夜空中最亮的星 · 逃跑计划/)).toBeInTheDocument();
  });

  it.each([
    { nextPhase: "waiting", expectedSaves: 1 },
    { nextPhase: "playing", expectedSaves: 0 },
  ] as const)("真实设置草稿在防抖窗内进入 $nextPhase 后保存次数为 $expectedSaves", async ({ nextPhase, expectedSaves }) => {
    vi.useFakeTimers();
    const sendCommandSpy = vi.fn().mockResolvedValue({});
    useSonGuessrStore.setState({ sendCommand: sendCommandSpy });

    renderRoomPage();
    fireEvent.click(screen.getByRole("button", { name: "猜测设置" }));
    const duration = screen.getByRole("textbox", { name: "每次猜测时限（秒）" });
    expect(duration).toHaveValue("60");
    fireEvent.change(duration, { target: { value: "90" } });
    fireEvent.blur(duration);
    expect(duration).toHaveValue("90");

    const settingsCalls = () => sendCommandSpy.mock.calls.filter(([type]) => type === "song.room.updateSettings");
    // 同一真实输入在 400ms 防抖完成前必须尚未保存，两分支刺激保持一致。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });
    expect(settingsCalls()).toHaveLength(0);

    if (nextPhase === "playing") {
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
      expect(screen.queryByRole("textbox", { name: "每次猜测时限（秒）" })).not.toBeInTheDocument();
      expect(settingsCalls()).toHaveLength(0);
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(settingsCalls()).toHaveLength(expectedSaves);
    if (expectedSaves === 1) {
      expect(settingsCalls()[0]).toEqual([
        "song.room.updateSettings",
        {
          lyricsLineCount: 4,
          showLyrics: true,
          maxGuessesPerRound: 5,
          guessDurationSeconds: 90,
          showGuessTimer: true,
          bloodMode: false,
        },
      ]);
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(settingsCalls()).toHaveLength(expectedSaves);
  });

  it.each([
    { panel: "题目设置", nextPhase: "waiting", expectedSaves: 1 },
    { panel: "题目设置", nextPhase: "playing", expectedSaves: 0 },
    { panel: "房间设置", nextPhase: "waiting", expectedSaves: 1 },
    { panel: "房间设置", nextPhase: "playing", expectedSaves: 0 },
  ] as const)("$panel 的真实草稿在399ms进入 $nextPhase 后保存次数为 $expectedSaves", async ({ panel, nextPhase, expectedSaves }) => {
    vi.useFakeTimers();
    const sendCommandSpy = vi.fn().mockResolvedValue({});
    useSonGuessrStore.setState({ sendCommand: sendCommandSpy });
    renderRoomPage();
    fireEvent.click(screen.getByRole("button", { name: panel }));
    if (panel === "题目设置") {
      expect(screen.getByRole("radio", { name: "手动出题" })).toBeChecked();
      fireEvent.click(screen.getByRole("radio", { name: "自动出题" }));
      expect(screen.getByRole("radio", { name: "自动出题" })).toBeChecked();
    } else {
      const name = screen.getByRole("textbox", { name: "房间名称" });
      fireEvent.change(name, { target: { value: "新房间名称" } });
      expect(name).toHaveValue("新房间名称");
    }
    const settingsCalls = () => sendCommandSpy.mock.calls.filter(([type]) => type === "song.room.updateSettings");
    await act(async () => { await vi.advanceTimersByTimeAsync(399); });
    expect(settingsCalls()).toHaveLength(0);
    if (nextPhase === "playing") {
      act(() => { useSonGuessrStore.setState({ snapshot: createMockSnapshot({ phase: "playing" }) }); });
      // 卸载刷新不能在防抖截止前偷发一次，之后推进时间也不得补发。
      expect(settingsCalls()).toHaveLength(0);
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(settingsCalls()).toHaveLength(expectedSaves);
    if (expectedSaves === 1) {
      expect(settingsCalls()[0]).toEqual([
        "song.room.updateSettings",
        panel === "题目设置"
          ? { questionType: "song", questionMode: "automatic", autoRotateSubmitter: false,
              autoFilters: { playlist: undefined, artists: [], minPopularity: 0 }, animeAutoFilters: {} }
          : { name: "新房间名称", visibility: "public", password: "", allowSpectators: true },
      ]);
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(settingsCalls()).toHaveLength(expectedSaves);
  });

  it.each([
    { currentRoomId: "TEST_ROOM", expectedSaves: 1 },
    { currentRoomId: "NEXT_ROOM", expectedSaves: 0 },
  ])("待保存设置卸载时当前房间为 $currentRoomId，保存次数为 $expectedSaves", async ({ currentRoomId, expectedSaves }) => {
    vi.useFakeTimers();
    const sendCommandSpy = vi.fn().mockResolvedValue({});
    useSonGuessrStore.setState({ sendCommand: sendCommandSpy });
    const { unmount } = renderRoomPage();
    fireEvent.click(screen.getByRole("button", { name: "猜测设置" }));
    const duration = screen.getByRole("textbox", { name: "每次猜测时限（秒）" });
    fireEvent.change(duration, { target: { value: "90" } });
    fireEvent.blur(duration);
    const settingsCalls = () => sendCommandSpy.mock.calls.filter(([type]) => type === "song.room.updateSettings");
    await act(async () => { await vi.advanceTimersByTimeAsync(399); });
    expect(settingsCalls()).toHaveLength(0);
    if (currentRoomId !== "TEST_ROOM") {
      act(() => { useSonGuessrStore.setState({ snapshot: createMockSnapshot({ roomId: currentRoomId }) }); });
    }
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(801); });
    expect(settingsCalls()).toHaveLength(expectedSaves);
    if (expectedSaves === 1) {
      expect(settingsCalls()[0]).toEqual([
        "song.room.updateSettings",
        { lyricsLineCount: 4, showLyrics: true, maxGuessesPerRound: 5,
          guessDurationSeconds: 90, showGuessTimer: true, bloodMode: false },
      ]);
    }
  });

  it("设置保存飞行中再编辑，进入playing后ACK不得补发旧草稿", async () => {
    vi.useFakeTimers();
    let resolveSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => { resolveSave = resolve; });
    const sendCommandSpy = vi.fn().mockReturnValueOnce(pendingSave).mockResolvedValue({});
    useSonGuessrStore.setState({ sendCommand: sendCommandSpy });
    renderRoomPage();
    fireEvent.click(screen.getByRole("button", { name: "猜测设置" }));
    const duration = screen.getByRole("textbox", { name: "每次猜测时限（秒）" });
    fireEvent.change(duration, { target: { value: "90" } });
    fireEvent.blur(duration);
    const settingsCalls = () => sendCommandSpy.mock.calls.filter(([type]) => type === "song.room.updateSettings");
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(settingsCalls()).toHaveLength(1);
    expect(settingsCalls()[0]?.[1]).toEqual({ lyricsLineCount: 4, showLyrics: true,
      maxGuessesPerRound: 5, guessDurationSeconds: 90, showGuessTimer: true, bloodMode: false });
    fireEvent.change(duration, { target: { value: "120" } });
    fireEvent.blur(duration);
    act(() => { useSonGuessrStore.setState({ snapshot: createMockSnapshot({ phase: "playing" }) }); });
    expect(settingsCalls()).toHaveLength(1);
    await act(async () => { resolveSave(); await vi.advanceTimersByTimeAsync(1_200); });
    expect(settingsCalls()).toHaveLength(1);
  });

  it("断线状态展示与房间被关闭自动退出到大厅", () => {
    renderRoomPage();

    // 1. 断线状态下展示提示
    act(() => {
      useSonGuessrStore.setState({ connected: false });
    });
    // 顶栏在宽屏写文字、窄屏收成图标（可访问名同一句），两处都可能在文档里
    expect(screen.getAllByText("断线中...").length).toBeGreaterThan(0);

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

  it("audio 节点不得声明 crossOrigin，否则无 ACAO 的解灰音源会被 CORS 直接拦掉", () => {
    const { container } = renderRoomPage();

    const audio = container.querySelector("audio");
    expect(audio).toBeInTheDocument();
    // 声明 crossOrigin 后浏览器会按 CORS 模式拉取媒体；kuwo 等解灰音源不返回
    // Access-Control-Allow-Origin，请求直接 net::ERR_FAILED，
    // 表现为「服务端解灰成功但客户端立刻 audioFailed」。全站无 Web Audio 用法，不需要该属性。
    expect(audio).not.toHaveAttribute("crossorigin");
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

  it("出题设置的互斥选项是由可见标签命名的单选组，选择后自动保存", async () => {
    const sendCommandSpy = vi.fn().mockResolvedValue({});
    useSonGuessrStore.setState({ sendCommand: sendCommandSpy });
    renderRoomPage();
    act(() => {
      useSonGuessrStore.setState({
        snapshot: createMockSnapshot({
          settings: { ...createMockSnapshot().settings, questionType: "anime", questionMode: "automatic" },
          phase: "waiting",
        }),
      });
    });
    fireEvent.click(screen.getByRole("button", { name: /题目设置/ }));

    expect(screen.getByRole("radio", { name: "听歌识番" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "自动出题" })).toBeChecked();
    const ranking = screen.getByRole("radiogroup", { name: "热度范围" });
    fireEvent.click(within(ranking).getByRole("radio", { name: "年榜" }));
    const popularity = screen.getByRole("radiogroup", { name: "网易云歌曲热度" });
    fireEvent.click(within(popularity).getByRole("radio", { name: "10000+" }));
    await waitFor(() => expect(sendCommandSpy).toHaveBeenCalledWith(
      "song.room.updateSettings",
      expect.objectContaining({ animeAutoFilters: expect.objectContaining({ ranking: "year", songMinPopularity: 10_000 }) }),
    ));

    fireEvent.click(screen.getByRole("radio", { name: "听歌识曲" }));
    const minPopularity = screen.getByRole("radiogroup", { name: "热度筛选" });
    fireEvent.click(within(minPopularity).getByRole("radio", { name: "1000+" }));
    await waitFor(() => expect(sendCommandSpy).toHaveBeenCalledWith(
      "song.room.updateSettings",
      expect.objectContaining({ questionType: "song", autoFilters: expect.objectContaining({ minPopularity: 1_000 }) }),
    ));
  });

  it("房主设置字段由可见标签命名，数值在失焦时才夹到范围内", async () => {
    const sendCommandSpy = vi.fn().mockResolvedValue({});
    useSonGuessrStore.setState({ sendCommand: sendCommandSpy });
    renderRoomPage();

    fireEvent.click(screen.getByRole("button", { name: "房间设置" }));
    expect(screen.getByRole("textbox", { name: "房间名称" })).toHaveValue("猜歌测试房");
    fireEvent.click(screen.getByRole("switch", { name: "私密房间" }));
    // 房间还没有密码：留空不会保存，占位文案不能再说「保留当前密码」。
    expect(screen.getByLabelText("房间密码")).toHaveAttribute("placeholder", "设置房间密码");

    fireEvent.click(screen.getByRole("button", { name: "猜测设置" }));
    const duration = screen.getByRole("textbox", { name: "每次猜测时限（秒）" });
    // 输入多位数的第一位时不提前夹到下限。
    fireEvent.change(duration, { target: { value: "1" } });
    expect(duration).toHaveValue("1");
    fireEvent.blur(duration);
    expect(duration).toHaveValue("10");
    await waitFor(() => expect(sendCommandSpy).toHaveBeenCalledWith(
      "song.room.updateSettings",
      expect.objectContaining({ guessDurationSeconds: 10 }),
    ));
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
    expect(screen.getByTestId("baka-song-lyric-container")).toHaveTextContent("夜空中最亮的星");

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

    // 校验请求已发出（出题耗时由上游决定，不带请求超时），按钮进入 loading 禁用态并渲染 spinner 与动态文案
    expect(sendCommandSpy).toHaveBeenCalledWith("song.game.start", {}, { timeout: 0 });
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

  it("出题等待期间每 3 秒同步一次房间状态，任务完成后停止轮询", async () => {
    let resolveCommand: (val?: unknown) => void = () => {};
    const pendingPromise = new Promise((resolve) => {
      resolveCommand = resolve;
    });
    const sendCommandSpy = vi.fn().mockImplementation((type: string) =>
      type === "song.room.requestSync" ? Promise.resolve({}) : pendingPromise,
    );

    useSonGuessrStore.setState({
      sendCommand: sendCommandSpy,
    });

    vi.useFakeTimers();
    try {
      renderRoomPage();
      fireEvent.click(screen.getByRole("button", { name: "开始游戏" }));

      const syncCallCount = () =>
        sendCommandSpy.mock.calls.filter(([type]) => type === "song.room.requestSync").length;

      // 出题命令本身不带超时，等待期间靠轮询把界面与后端真实进度对齐。
      expect(syncCallCount()).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(syncCallCount()).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(syncCallCount()).toBe(3);

      // 命令完成后停止轮询，不再空转请求
      await act(async () => {
        resolveCommand({});
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_000);
      });
      expect(syncCallCount()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
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

    expect(sendCommandSpy).toHaveBeenCalledWith("song.game.nextRound", {}, { timeout: 0 });
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

  it("退出房间后再次进入房间，清除历史关闭状态且绝不发生原地跳转", async () => {
    useSonGuessrStore.setState({
      ...initialStoreState,
      connected: true,
      roomClosedAt: Date.now() - 1000,
      roomId: "6688",
      snapshot: createMockSnapshot({ roomId: "6688" }),
      privateState: createMockPrivateState(),
    });

    const { unmount } = render(
      <MemoryRouter initialEntries={["/songuessr/room/1234"]}>
        <Routes>
          <Route path="/songuessr/room/:roomId" element={<SonGuessrRoomPage />} />
          <Route path="/songuessr" element={<div>Songuessr 游戏大厅</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(useSonGuessrStore.getState().roomClosedAt).toBeNull();
    expect(screen.queryByText("Songuessr 游戏大厅")).not.toBeInTheDocument();
    unmount();
  });

  it("单人模式退出房间后再次进入，清空旧房间号并顺利初始化新单人对局", async () => {
    useSonGuessrStore.setState({
      ...initialStoreState,
      roomClosedAt: Date.now() - 2000,
      roomId: null,
      snapshot: null,
      privateState: null,
    });

    render(
      <MemoryRouter initialEntries={["/songuessr/solo"]}>
        <Routes>
          <Route path="/songuessr/solo" element={<SonGuessrRoomPage solo />} />
          <Route path="/" element={<div>游戏首页</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByText("游戏首页")).not.toBeInTheDocument();
    expect(useSonGuessrStore.getState().roomClosedAt).toBeNull();
  });
});
