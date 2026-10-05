import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CCBGuess } from "@bakagame/shared";
import { CCBFeedbackTable } from "./CCBFeedbackTable";

const guess: CCBGuess = {
  id: "guess", playerId: "player", playerName: "玩家", correct: false, partial: false,
  syncRound: 1, createdAt: 1,
  character: { id: 1, name: "角色", nameCn: "角色", imageUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" },
  feedback: {
    gender: { value: "female", comparison: "yes" }, popularity: { value: 200, comparison: "+" },
    rating: { value: -1, comparison: "?" }, appearancesCount: { value: 10, comparison: "++" },
    earliestAppearance: { value: 2010, comparison: "-" }, latestAppearance: { value: 2012, comparison: "--" },
    sharedAppearances: [], tags: [], extraTags: [],
  },
};

describe("角色反馈", () => {
  it("原版仅提供作品编号时仍显示可辨认的作品信息", () => {
    render(<CCBFeedbackTable guesses={[{ ...guess, feedback: { ...guess.feedback, sharedAppearances: [{ id: 120, name: "", nameCn: "" }] } }]} />);
    expect(screen.getByText(/作品 120/)).toBeInTheDocument();
  });

  it("游戏专属标签按分区展示匹配情况并将上游内容作为安全文本", () => {
    const payload = '<img src="x" onerror="alert(1)">';
    const enriched: CCBGuess = { ...guess, feedback: { ...guess.feedback, extraTags: [
      { section: "角色能力", tags: [{ text: "吉他", matched: true }, { text: payload, matched: false }] },
    ] } };
    render(<CCBFeedbackTable guesses={[enriched]} />);
    const toggle = screen.getByRole("button", { name: "游戏专属标签" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("角色能力")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("角色能力")).toBeInTheDocument();
    expect(screen.getByText(payload)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: payload })).not.toBeInTheDocument();
    expect(screen.getByText("吉他").querySelector('[aria-label="匹配"]')).toBeInTheDocument();
  });

  it("以答案方向解释猜测与答案的数值差，并隐藏未知评分哨兵", () => {
    render(<CCBFeedbackTable guesses={[guess]} />);
    const [profile, works, years] = screen.getAllByRole("cell");
    expect(within(profile).getByLabelText("匹配")).toBeInTheDocument();
    expect(profile).toHaveTextContent("性别女");
    expect(within(profile).getByLabelText("答案更低")).toBeInTheDocument();
    expect(within(works).getByLabelText("答案低很多")).toBeInTheDocument();
    expect(works).toHaveTextContent("最高分未知");
    expect(works).not.toHaveTextContent("-1");
    expect(within(years).getByLabelText("答案高很多")).toBeInTheDocument();
    expect(within(years).getByLabelText("答案更高")).toBeInTheDocument();
  });

  it("一次猜测一行，最新的在最上面，角色名作行标题并标出结果", () => {
    const earlier: CCBGuess = { ...guess, id: "earlier", character: { ...guess.character, id: 2, name: "ぼっち", nameCn: "后藤一里" }, createdAt: 0 };
    const correct: CCBGuess = { ...guess, id: "correct", correct: true, character: { ...guess.character, id: 3, name: "伊地知虹夏", nameCn: "伊地知虹夏" }, createdAt: 2 };
    render(<CCBFeedbackTable guesses={[earlier, correct]} />);
    const headers = screen.getAllByRole("rowheader");
    expect(headers.map((header) => header.textContent)).toEqual([expect.stringMatching(/^伊地知虹夏玩家/), expect.stringMatching(/^ぼっち后藤一里/)]);
    expect(within(headers[0]!).getByText("猜中")).toBeInTheDocument();
    // 中日同名时不重复副名。
    expect(within(headers[0]!).getAllByText("伊地知虹夏")).toHaveLength(1);
    expect(screen.getByRole("columnheader", { name: "作品数与最高分" })).toBeInTheDocument();
  });

  it("同步模式才在角色名下标出轮次", () => {
    const { rerender } = render(<CCBFeedbackTable guesses={[guess]} />);
    expect(screen.queryByText(/第 1 轮/)).not.toBeInTheDocument();
    rerender(<CCBFeedbackTable guesses={[guess]} showRound />);
    expect(screen.getByText(/第 1 轮/)).toBeInTheDocument();
  });

  describe("共同作品", () => {
    const shared = (count: number): CCBGuess => ({ ...guess, feedback: { ...guess.feedback, sharedAppearances:
      Array.from({ length: count }, (_, index) => ({ id: index + 1, name: "", nameCn: `作品${index + 1}` })) } });
    // jsdom 没有布局：按「两行装得下几部」模拟截断，收起时 clientHeight 是两行、scrollHeight 随内容增长。
    const fakeLayout = (perTwoLines: number) => {
      const line = 16;
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("line-clamp-2") ? line * 2 : this.scrollHeight;
      });
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
        const count = (this.textContent?.match(/作品\d+/g) ?? []).length;
        return Math.ceil(count / (perTwoLines / 2)) * line;
      });
    };
    afterEach(() => vi.restoreAllMocks());

    it("两行放得下时不出现展开箭头", () => {
      fakeLayout(4);
      render(<CCBFeedbackTable guesses={[shared(3)]} />);
      expect(screen.getByText(/共同作品：作品1、作品2、作品3/)).toHaveClass("line-clamp-2");
      expect(screen.queryByRole("button", { name: /共同作品/ })).not.toBeInTheDocument();
    });

    it("超过两行时默认截断，箭头展开全文后仍可收起", () => {
      fakeLayout(4);
      render(<CCBFeedbackTable guesses={[shared(9)]} />);
      const text = screen.getByText(/共同作品：作品1/);
      const toggle = screen.getByRole("button", { name: "展开共同作品" });
      expect(text).toHaveClass("line-clamp-2");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveAttribute("aria-controls", text.id);

      fireEvent.click(toggle);
      expect(text).not.toHaveClass("line-clamp-2");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(toggle).toHaveAccessibleName("收起共同作品");

      fireEvent.click(toggle);
      expect(text).toHaveClass("line-clamp-2");
      expect(screen.getByRole("button", { name: "展开共同作品" })).toHaveAttribute("aria-expanded", "false");
    });
  });
});
