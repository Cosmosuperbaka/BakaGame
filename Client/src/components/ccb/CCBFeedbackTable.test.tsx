import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    expect(screen.getByText("作品 120")).toBeInTheDocument();
  });

  it("游戏专属标签按分区展示匹配情况并将上游内容作为安全文本", () => {
    const payload = '<img src="x" onerror="alert(1)">';
    const enriched: CCBGuess = { ...guess, feedback: { ...guess.feedback, extraTags: [
      { section: "角色能力", tags: [{ text: "吉他", matched: true }, { text: payload, matched: false }] },
    ] } };
    render(<CCBFeedbackTable guesses={[enriched]} />);
    expect(screen.getByText("游戏专属标签")).toBeInTheDocument();
    expect(screen.getByText("角色能力")).toBeInTheDocument();
    expect(screen.getByText(payload)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: payload })).not.toBeInTheDocument();
    expect(screen.getByText("吉他").querySelector('[aria-label="匹配"]')).toBeInTheDocument();
  });

  it("以答案方向解释猜测与答案的数值差，并隐藏未知评分哨兵", () => {
    render(<CCBFeedbackTable guesses={[guess]} />);
    const cells = screen.getAllByRole("cell");
    expect(within(cells[1]).getByLabelText("答案更低")).toBeInTheDocument();
    expect(within(cells[3]).getByLabelText("答案低很多")).toBeInTheDocument();
    expect(within(cells[4]).getByLabelText("答案更高")).toBeInTheDocument();
    expect(within(cells[5]).getByLabelText("答案高很多")).toBeInTheDocument();
    expect(cells[2]).toHaveTextContent("未知");
    expect(cells[2]).not.toHaveTextContent("-1");
  });
});
