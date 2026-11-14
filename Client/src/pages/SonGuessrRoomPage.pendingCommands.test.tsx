import { act, fireEvent, screen, within } from "@testing-library/react";
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
  createMockSnapshot,
  renderRoomPage,
  registerRoomPageHooks,
} from "@/test/SonGuessrRoomPageFixtures";

describe("SonGuessrRoomPage 页面级集成测试", () => {
  registerRoomPageHooks();

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
    // 空载荷由 store 的 `sendCommand` 统一补成 `{}`，组件侧省略即视为无载荷。
    expect(sendCommandSpy).toHaveBeenCalledWith("song.game.start", undefined, { timeout: 0 });
    expect(startButton).toBeDisabled();
    expect(startButton).toHaveAttribute("aria-busy", "true");
    expect(within(startButton).getByTestId("button-spinner")).toBeInTheDocument();
    // 进行中文案保持原名，只把图标位换成转圈
    expect(startButton).toHaveTextContent("开始游戏");

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
    const sendCommandSpy = vi
      .fn()
      .mockImplementation((type: string) =>
        type === "song.room.requestSync" ? Promise.resolve({}) : pendingPromise
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

    expect(sendCommandSpy).toHaveBeenCalledWith("song.game.nextRound", undefined, { timeout: 0 });
    expect(nextRoundButton).toBeDisabled();
    expect(nextRoundButton).toHaveAttribute("aria-busy", "true");
    expect(within(nextRoundButton).getByTestId("button-spinner")).toBeInTheDocument();
    expect(nextRoundButton).toHaveTextContent("再来一轮");

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
