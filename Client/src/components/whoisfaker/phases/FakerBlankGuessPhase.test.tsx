import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WhoIsFakerPrivateState, WhoIsFakerRoomSnapshot } from "@bakagame/shared";
import { recordClockSample, resetClockSample } from "@/stores/UseServerClock";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { WIF_PEOPLE, wifPrivate, wifSnapshot } from "@/stories/fixtures/WhoIsFaker";
import { BlankGuessStage } from "./FakerBlankGuessPhase";

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
    addToast: vi.fn(),
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
