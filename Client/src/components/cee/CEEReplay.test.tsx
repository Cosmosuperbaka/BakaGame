import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CEEReplay } from "./CEEReplay";
import { CEE_REPLAY_STORAGE_KEY, type ReplayRound } from "@/lib/CeeReplay";
import { CEE_CHARACTERS, ceeGuess } from "@/stories/fixtures/CEE";
import { STORY_PLAYERS } from "@/stories/fixtures/Common";

const [host, me] = STORY_PLAYERS;
const rounds: ReplayRound[] = [
  {
    number: 1,
    answer: CEE_CHARACTERS.hitori,
    guesses: [
      ceeGuess({ player: host, character: "nijika", at: 3 }, "hitori"),
      ceeGuess({ player: me, character: "hitori", at: 8 }, "hitori"),
    ],
  },
];

const panel = () => screen.queryByRole("region", { name: "猜测回放" });
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};
const advance = async (milliseconds: number) => {
  await act(async () => {
    vi.advanceTimersByTime(milliseconds);
  });
};

describe("CEE 猜测回放", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.removeItem(CEE_REPLAY_STORAGE_KEY);
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.removeItem(CEE_REPLAY_STORAGE_KEY);
  });

  it("开关默认关闭：结算页不出现回放", () => {
    render(<CEEReplay rounds={rounds} />);
    expect(panel()).toBeNull();
  });

  it("开启后从第一条开始自动播放，按时间推进", async () => {
    window.localStorage.setItem(CEE_REPLAY_STORAGE_KEY, "1");
    render(<CEEReplay rounds={rounds} />);
    expect(panel()).not.toBeNull();
    expect(screen.getByText(/1\/2/)).toBeInTheDocument();
    expect(screen.getByText(`${host.name} 猜`)).toBeInTheDocument();

    await advance(1_400);
    expect(screen.getByText(/2\/2/)).toBeInTheDocument();
    expect(screen.getByText(`${me.name} 猜`)).toBeInTheDocument();
  });

  it("手动逐条切换并暂停自动播放", async () => {
    window.localStorage.setItem(CEE_REPLAY_STORAGE_KEY, "1");
    render(<CEEReplay rounds={rounds} />);

    await click("下一条");
    expect(screen.getByText(/2\/2/)).toBeInTheDocument();
    // 手动切换即暂停：回放不会自己继续往下走。
    await advance(3_000);
    expect(screen.getByText(/2\/2/)).toBeInTheDocument();

    await click("上一条");
    expect(screen.getByText(/1\/2/)).toBeInTheDocument();

    await click("播放回放");
    expect(screen.getByRole("button", { name: "暂停回放" })).toBeInTheDocument();
    await advance(1_400);
    expect(screen.getByText(/2\/2/)).toBeInTheDocument();
  });

  it("播完最后一条自动停在结尾，再按播放从头重播", async () => {
    window.localStorage.setItem(CEE_REPLAY_STORAGE_KEY, "1");
    render(<CEEReplay rounds={rounds} />);

    await advance(5_000);
    expect(screen.getByText(/2\/2/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "播放回放" })).toBeInTheDocument();

    await click("播放回放");
    expect(screen.getByText(/1\/2/)).toBeInTheDocument();
  });

  it("整局多回合按回合顺序重演", async () => {
    window.localStorage.setItem(CEE_REPLAY_STORAGE_KEY, "1");
    render(<CEEReplay rounds={[
      rounds[0]!,
      { number: 2, answer: CEE_CHARACTERS.ryo, guesses: [ceeGuess({ player: host, character: "ryo", at: 4 }, "ryo")] },
    ]} />);
    expect(screen.getByText(/第 1 回合/)).toBeInTheDocument();
    expect(screen.getByText(/1\/3/)).toBeInTheDocument();

    await advance(1_400);
    await advance(1_400);
    expect(screen.getByText(/第 2 回合/)).toBeInTheDocument();
    expect(screen.getByText(/3\/3/)).toBeInTheDocument();
  });

  it("没有猜测时给出空态而不是空白面板", () => {
    window.localStorage.setItem(CEE_REPLAY_STORAGE_KEY, "1");
    render(<CEEReplay rounds={[]} />);
    expect(screen.getByText("本局还没有记录到猜测")).toBeInTheDocument();
  });
});
