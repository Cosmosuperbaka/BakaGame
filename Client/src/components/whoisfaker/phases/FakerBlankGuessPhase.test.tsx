import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WhoIsFakerPrivateState, WhoIsFakerRoomSnapshot } from "@bakagame/shared";
import { recordClockSample, resetClockSample } from "@/stores/UseServerClock";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { WIF_PEOPLE, WIF_WORDS, wifPrivate, wifSnapshot } from "@/stories/fixtures/WhoIsFaker";
import { BlankGuessButton, BlankGuessStage } from "./FakerBlankGuessPhase";

type SendCommand = ReturnType<typeof useWhoIsFakerStore.getState>["sendCommand"];

const NOW = 1_700_000_000_000;

function mount(endsAt: number, sendCommand: ReturnType<typeof vi.fn>) {
  const base = wifSnapshot("blankGuess");
  const me = WIF_PEOPLE.kita;
  const snapshot: WhoIsFakerRoomSnapshot = {
    ...base,
    status: {
      ...base.status,
      blankGuessPlayerId: me.id,
      phaseTimer: { durationSeconds: 60, endsAt, phase: "blankGuess" },
    },
  };
  const privateState: WhoIsFakerPrivateState = wifPrivate(me, "blankGuess");
  useWhoIsFakerStore.setState({
    snapshot,
    privateState,
    sendCommand: sendCommand as unknown as SendCommand,
    showToast: vi.fn(),
  });
  render(<BlankGuessStage />);
  fireEvent.change(screen.getByLabelText("词语 A"), { target: { value: "苹果" } });
  fireEvent.change(screen.getByLabelText("词语 B"), { target: { value: "香蕉" } });
}

const submitCalls = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.filter(([type]) => type === "game.submitBlankGuess");
/** 分小步推进、每步单独 act：React 才会在步与步之间真的渲染，「提交中」的亮灭才看得见。 */
const advance = async (ms: number) => {
  for (let left = ms; left > 0; left -= 25) {
    await act(async () => void (await vi.advanceTimersByTimeAsync(Math.min(25, left))));
  }
};

describe("白板猜词超时自动提交", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    resetClockSample();
    vi.useRealTimers();
  });

  it("两个词都已填，倒计时归零时自动提交一次", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    mount(NOW + 10_000, sendCommand);
    await advance(9_900);
    expect(submitCalls(sendCommand)).toHaveLength(0);
    await advance(200);
    expect(submitCalls(sendCommand)).toEqual([
      ["game.submitBlankGuess", { words: ["苹果", "香蕉"] }],
    ]);
  });

  it("本机时钟比服务端快时，按校正后的到点时刻提交", async () => {
    recordClockSample(NOW - 5_000, NOW, NOW);
    const sendCommand = vi.fn().mockResolvedValue({});
    mount(NOW + 10_000, sendCommand);
    await advance(14_900);
    expect(submitCalls(sendCommand)).toHaveLength(0);
    await advance(200);
    expect(submitCalls(sendCommand)).toHaveLength(1);
  });

  it("提交失败后同一截止时刻不再自动重试", async () => {
    const sendCommand = vi.fn(async (type: string) => {
      if (type === "game.submitBlankGuess") {
        // 真实网络下失败总在渲染之后才回来，「提交中」会真的亮一次再复位
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error("阶段已变化");
      }
      return {};
    });
    mount(NOW + 1_000, sendCommand as unknown as ReturnType<typeof vi.fn>);
    await advance(1_100);
    expect(submitCalls(sendCommand as unknown as ReturnType<typeof vi.fn>)).toHaveLength(1);
    await advance(30_000);
    expect(submitCalls(sendCommand as unknown as ReturnType<typeof vi.fn>)).toHaveLength(1);
  });
});

describe("白板猜词的交互", () => {
  const initial = useWhoIsFakerStore.getState();
  const enter = (viewer: Parameters<typeof wifPrivate>[0], stage: "day3" | "blankGuess") => {
    const sendCommand = vi.fn().mockResolvedValue({});
    useWhoIsFakerStore.setState({
      snapshot: wifSnapshot(stage),
      privateState: wifPrivate(viewer, stage),
      sendCommand: sendCommand as unknown as SendCommand,
      showToast: vi.fn(),
    });
    return sendCommand;
  };

  afterEach(() => {
    // 组件按「已在房间里」写，取快照时不判空：先卸载再还原 Store，否则还原会触发一次空快照渲染。
    cleanup();
    useWhoIsFakerStore.setState(initial, true);
  });

  it("入口先确认再发命令，取消不发；机会用掉后入口收起", async () => {
    const sendCommand = enter(WIF_PEOPLE.kita, "day3");
    render(<BlankGuessButton />);

    fireEvent.click(screen.getByRole("button", { name: "白板猜词" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "再想想" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sendCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "白板猜词" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "进入猜词" })
    );
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith("game.enterBlankGuess"));
    // 弹窗在场时正文被 aria-hidden 挡住，按角色查按钮会一律查不到：先等它退场。
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    act(() =>
      useWhoIsFakerStore.setState((state) => ({
        privateState: { ...state.privateState!, blankGuessUsed: true },
      }))
    );
    expect(screen.queryByRole("button", { name: "白板猜词" })).toBeNull();
  });

  it("两个词都填了才能提交，提交带上修剪后的词", async () => {
    const sendCommand = enter(WIF_PEOPLE.kita, "blankGuess");
    render(<BlankGuessStage />);

    const submit = screen.getByRole("button", { name: "提交猜测" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("词语 A"), { target: { value: " 饺子 " } });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("词语 B"), { target: { value: "汤圆" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(submitCalls(sendCommand)).toEqual([
        ["game.submitBlankGuess", { words: ["饺子", "汤圆"] }],
      ])
    );
  });

  it("待裁定时只有主持人看得到真实词对与裁定按钮，两个按钮各发对应的判定", async () => {
    const sendCommand = enter("host", "blankGuess");
    useWhoIsFakerStore.setState({ snapshot: wifSnapshot("blankReview") });
    const host = render(<BlankGuessStage />);

    expect(
      screen.getByText(`${WIF_WORDS.civilianWord} / ${WIF_WORDS.undercoverWord}`)
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "算作正确" }));
    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith("game.reviewBlankGuess", { approve: true })
    );
    fireEvent.click(screen.getByRole("button", { name: "判定错误" }));
    await waitFor(() =>
      expect(sendCommand).toHaveBeenCalledWith("game.reviewBlankGuess", { approve: false })
    );
    host.unmount();

    enter(WIF_PEOPLE.me, "blankGuess");
    useWhoIsFakerStore.setState({ snapshot: wifSnapshot("blankReview") });
    const player = render(<BlankGuessStage />);
    expect(screen.queryByRole("button", { name: "算作正确" })).toBeNull();
    expect(screen.queryByRole("button", { name: "判定错误" })).toBeNull();
    expect(
      screen.queryByText(`${WIF_WORDS.civilianWord} / ${WIF_WORDS.undercoverWord}`)
    ).toBeNull();
    player.unmount();

    // 旁观者同样拿得到真实词对，只有主持人身份才决定能不能裁定：普通玩家那一档词对本来就是空的，
    // 单看它区分不出「按身份放行」还是「按有没有词对放行」。
    enter("spectator", "blankGuess");
    useWhoIsFakerStore.setState({ snapshot: wifSnapshot("blankReview") });
    render(<BlankGuessStage />);
    expect(screen.queryByRole("button", { name: "算作正确" })).toBeNull();
    expect(screen.queryByRole("button", { name: "判定错误" })).toBeNull();
  });
});
