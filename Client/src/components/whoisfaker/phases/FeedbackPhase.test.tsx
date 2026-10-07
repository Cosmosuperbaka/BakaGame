import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { WIF_PEOPLE, wifFeedbackSnapshot, wifPrivate, wifSnapshot } from "@/stories/fixtures/WhoIsFaker";
import { FeedbackPhase } from "./FeedbackPhase";
import { GameOverPhase } from "./GameOverPhase";

const { stone, azumi, peach, kita, yuzu } = WIF_PEOPLE;
const sendCommand = vi.fn().mockResolvedValue({});

beforeEach(() => {
  useWhoIsFakerStore.setState(useWhoIsFakerStore.getInitialState(), true);
  sendCommand.mockClear();
});
afterEach(() => {
  cleanup();
  useWhoIsFakerStore.setState(useWhoIsFakerStore.getInitialState(), true);
});

describe("阶段反馈", () => {
  it("投票反馈公开票型与出局者，主持人按预判的下一阶段继续", async () => {
    useWhoIsFakerStore.setState({ snapshot: wifFeedbackSnapshot("vote"), privateState: wifPrivate("host", "night1"), sendCommand });
    render(<FeedbackPhase />);
    expect(screen.getByRole("heading", { name: "第 1 天投票结果" })).toBeVisible();
    // 石头四票出局
    expect(screen.getByText(stone.name, { selector: ".text-destructive" })).toBeVisible();
    // 得票徽章逐个入场，jsdom 里停在起始帧，只断言存在
    expect(screen.getByText("4 票")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "进入夜晚" }));
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith("game.advancePhase"));
  });

  it("平票反馈列出 PK 候选；非主持人只能等待", () => {
    useWhoIsFakerStore.setState({ snapshot: wifFeedbackSnapshot("tie"), privateState: wifPrivate("me", "tie2"), sendCommand });
    render(<FeedbackPhase />);
    expect(screen.getByText(`${peach.name}、${kita.name}`)).toBeVisible();
    expect(screen.getByText("等待主持人继续")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("夜晚反馈只公布出局者，不公开凶手", () => {
    useWhoIsFakerStore.setState({ snapshot: wifFeedbackSnapshot("night"), privateState: wifPrivate("me", "day2"), sendCommand });
    render(<FeedbackPhase />);
    expect(screen.getByRole("heading", { name: "天亮了" })).toBeVisible();
    expect(screen.getByText(azumi.name)).toBeVisible();
    expect(screen.queryByText(peach.name)).toBeNull();
    expect(screen.queryByText(yuzu.name)).toBeNull();
  });

  it("白板猜词反馈只给最终两词与对错", () => {
    useWhoIsFakerStore.setState({ snapshot: wifFeedbackSnapshot("blankGuess"), privateState: wifPrivate("host", "blankReview"), sendCommand });
    render(<FeedbackPhase />);
    expect(screen.getByText("猜中")).toBeVisible();
    expect(screen.getByText("经主持人裁定")).toBeVisible();
    expect(screen.getByRole("button", { name: "查看结算" })).toBeVisible();
  });
});

describe("结算全局历史", () => {
  it("按天列出每个结算阶段的行为，夜里的行动者在这里公开", () => {
    useWhoIsFakerStore.setState({ snapshot: wifSnapshot("over"), privateState: wifPrivate("me", "over"), sendCommand });
    render(<GameOverPhase />);
    expect(screen.getByRole("button", { name: /全局历史/ })).toHaveAttribute("aria-expanded", "true");
    // 有全局历史时不再重复旧的投票明细
    expect(screen.queryByRole("button", { name: /投票明细/ })).toBeNull();
    const days = screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
    expect(days).toEqual(["第 1 天", "第 2 天", "第 3 天"]);
    const day1 = screen.getAllByRole("list").find((list) => within(list).queryByText("夜晚"))!;
    expect(within(day1).getByText(`${peach.name}（卧底）`)).toBeVisible();
    expect(within(day1).getAllByText("刀了").length).toBe(2);
    expect(screen.getByText("平票 PK 投票")).toBeVisible();
  });
});
