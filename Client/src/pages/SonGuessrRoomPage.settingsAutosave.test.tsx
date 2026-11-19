import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
import {
  createMockPrivateState,
  createMockSnapshot,
  renderRoomPage,
  registerRoomPageHooks,
} from "@/test/SonGuessrRoomPageFixtures";

describe("SonGuessrRoomPage 页面级集成测试", () => {
  registerRoomPageHooks();

  it.each([
    { nextPhase: "waiting", expectedSaves: 1 },
    { nextPhase: "playing", expectedSaves: 0 },
  ] as const)(
    "真实设置草稿在防抖窗内进入 $nextPhase 后保存次数为 $expectedSaves",
    async ({ nextPhase, expectedSaves }) => {
      vi.useFakeTimers();
      const sendCommandSpy = vi.fn().mockResolvedValue({});
      useSonGuessrStore.setState({ sendCommand: sendCommandSpy });

      renderRoomPage();
      fireEvent.click(screen.getByRole("button", { name: "猜测设置" }));
      const duration = screen.getByRole("spinbutton", { name: "每次猜测时限（秒）" });
      expect(duration).toHaveValue("60");
      fireEvent.change(duration, { target: { value: "90" } });
      fireEvent.blur(duration);
      expect(duration).toHaveValue("90");

      const settingsCalls = () =>
        sendCommandSpy.mock.calls.filter(([type]) => type === "song.room.updateSettings");
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
        expect(
          screen.queryByRole("spinbutton", { name: "每次猜测时限（秒）" })
        ).not.toBeInTheDocument();
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
    }
  );

  it.each([
    { panel: "题目设置", nextPhase: "waiting", expectedSaves: 1 },
    { panel: "题目设置", nextPhase: "playing", expectedSaves: 0 },
    { panel: "房间设置", nextPhase: "waiting", expectedSaves: 1 },
    { panel: "房间设置", nextPhase: "playing", expectedSaves: 0 },
  ] as const)(
    "$panel 的真实草稿在399ms进入 $nextPhase 后保存次数为 $expectedSaves",
    async ({ panel, nextPhase, expectedSaves }) => {
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
      const settingsCalls = () =>
        sendCommandSpy.mock.calls.filter(([type]) => type === "song.room.updateSettings");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(399);
      });
      expect(settingsCalls()).toHaveLength(0);
      if (nextPhase === "playing") {
        act(() => {
          useSonGuessrStore.setState({ snapshot: createMockSnapshot({ phase: "playing" }) });
        });
        // 卸载刷新不能在防抖截止前偷发一次，之后推进时间也不得补发。
        expect(settingsCalls()).toHaveLength(0);
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(settingsCalls()).toHaveLength(expectedSaves);
      if (expectedSaves === 1) {
        expect(settingsCalls()[0]).toEqual([
          "song.room.updateSettings",
          panel === "题目设置"
            ? {
                questionType: "song",
                questionMode: "automatic",
                autoRotateSubmitter: false,
                allowCustomClip: true,
                autoFilters: { playlist: undefined, artists: [], minPopularity: 0 },
                animeAutoFilters: {},
              }
            : {
                name: "新房间名称",
                visibility: "public",
                password: "",
                allowSpectators: true,
                spectatorsSeeAnswers: false,
              },
        ]);
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(settingsCalls()).toHaveLength(expectedSaves);
    }
  );

  it.each([
    { currentRoomId: "TEST_ROOM", expectedSaves: 1 },
    { currentRoomId: "NEXT_ROOM", expectedSaves: 0 },
  ])(
    "待保存设置卸载时当前房间为 $currentRoomId，保存次数为 $expectedSaves",
    async ({ currentRoomId, expectedSaves }) => {
      vi.useFakeTimers();
      const sendCommandSpy = vi.fn().mockResolvedValue({});
      useSonGuessrStore.setState({ sendCommand: sendCommandSpy });
      const { unmount } = renderRoomPage();
      fireEvent.click(screen.getByRole("button", { name: "猜测设置" }));
      const duration = screen.getByRole("spinbutton", { name: "每次猜测时限（秒）" });
      fireEvent.change(duration, { target: { value: "90" } });
      fireEvent.blur(duration);
      const settingsCalls = () =>
        sendCommandSpy.mock.calls.filter(([type]) => type === "song.room.updateSettings");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(399);
      });
      expect(settingsCalls()).toHaveLength(0);
      if (currentRoomId !== "TEST_ROOM") {
        act(() => {
          useSonGuessrStore.setState({ snapshot: createMockSnapshot({ roomId: currentRoomId }) });
        });
      }
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(801);
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
    }
  );

  it("设置保存飞行中再编辑，进入playing后ACK不得补发旧草稿", async () => {
    vi.useFakeTimers();
    let resolveSave!: () => void;
    const pendingSave = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const sendCommandSpy = vi.fn().mockReturnValueOnce(pendingSave).mockResolvedValue({});
    useSonGuessrStore.setState({ sendCommand: sendCommandSpy });
    renderRoomPage();
    fireEvent.click(screen.getByRole("button", { name: "猜测设置" }));
    const duration = screen.getByRole("spinbutton", { name: "每次猜测时限（秒）" });
    fireEvent.change(duration, { target: { value: "90" } });
    fireEvent.blur(duration);
    const settingsCalls = () =>
      sendCommandSpy.mock.calls.filter(([type]) => type === "song.room.updateSettings");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(settingsCalls()).toHaveLength(1);
    expect(settingsCalls()[0]?.[1]).toEqual({
      lyricsLineCount: 4,
      showLyrics: true,
      maxGuessesPerRound: 5,
      guessDurationSeconds: 90,
      showGuessTimer: true,
      bloodMode: false,
    });
    fireEvent.change(duration, { target: { value: "120" } });
    fireEvent.blur(duration);
    act(() => {
      useSonGuessrStore.setState({ snapshot: createMockSnapshot({ phase: "playing" }) });
    });
    expect(settingsCalls()).toHaveLength(1);
    await act(async () => {
      resolveSave();
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(settingsCalls()).toHaveLength(1);
  });

  it("出题设置的互斥选项是由可见标签命名的单选组，选择后自动保存", async () => {
    const sendCommandSpy = vi.fn().mockResolvedValue({});
    useSonGuessrStore.setState({ sendCommand: sendCommandSpy });
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
    fireEvent.click(screen.getByRole("button", { name: /题目设置/ }));

    expect(screen.getByRole("radio", { name: "听歌识番" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "自动出题" })).toBeChecked();
    const ranking = screen.getByRole("radiogroup", { name: "热度范围" });
    fireEvent.click(within(ranking).getByRole("radio", { name: "年榜" }));
    // 刻度滑动条：0、500、1000、2000、3000、5000、7500、10000……，从不限向右七档落到 10000。
    const popularity = screen.getByRole("slider", { name: "网易云歌曲热度" });
    expect(popularity).toHaveAttribute("aria-valuetext", "不限");
    popularity.focus();
    for (let step = 0; step < 7; step += 1) fireEvent.keyDown(popularity, { key: "ArrowRight" });
    await waitFor(() =>
      expect(sendCommandSpy).toHaveBeenCalledWith(
        "song.room.updateSettings",
        expect.objectContaining({
          animeAutoFilters: expect.objectContaining({ ranking: "year", songMinPopularity: 10_000 }),
        })
      )
    );

    fireEvent.click(screen.getByRole("radio", { name: "听歌识曲" }));
    const minPopularity = screen.getByRole("slider", { name: "热度筛选" });
    minPopularity.focus();
    fireEvent.keyDown(minPopularity, { key: "ArrowRight" });
    fireEvent.keyDown(minPopularity, { key: "ArrowRight" });
    await waitFor(() =>
      expect(sendCommandSpy).toHaveBeenCalledWith(
        "song.room.updateSettings",
        expect.objectContaining({
          questionType: "song",
          autoFilters: expect.objectContaining({ minPopularity: 1_000 }),
        })
      )
    );
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
    const duration = screen.getByRole("spinbutton", { name: "每次猜测时限（秒）" });
    // 输入多位数的第一位时不提前夹到下限。
    fireEvent.change(duration, { target: { value: "1" } });
    expect(duration).toHaveValue("1");
    fireEvent.blur(duration);
    expect(duration).toHaveValue("10");
    await waitFor(() =>
      expect(sendCommandSpy).toHaveBeenCalledWith(
        "song.room.updateSettings",
        expect.objectContaining({ guessDurationSeconds: 10 })
      )
    );
  });
});
