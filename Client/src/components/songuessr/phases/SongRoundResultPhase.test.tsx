import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SongScoreTable } from "./SongRoundResultPhase";

const scores = [
  { playerId: "p1", playerName: "甲", score: 12, delta: 12, correctGuesses: 1, totalGuesses: 1 },
];

describe("猜歌结算得分表", () => {
  it("有计分拆解时给出难度分与逐人速度/精度系数", () => {
    render(
      <SongScoreTable
        scores={scores}
        contributors={["p1"]}
        breakdown={{
          difficulty: 0.29,
          answerableCount: 1,
          players: [{ playerId: "p1", speed: 1.16, precision: 1, score: 12 }],
        }}
      />
    );
    expect(screen.getByRole("heading", { name: "得分统计 · 难度 0.29" })).toBeInTheDocument();
    expect(screen.getByText(/^速度 1\.16/)).toBeInTheDocument();
    expect(screen.getByText("精度 1.00")).toBeInTheDocument();
  });

  it("旧口径或历史对局没有拆解时退回纯得分表", () => {
    render(<SongScoreTable scores={scores} contributors={["p1"]} />);
    expect(screen.getByRole("heading", { name: "得分统计" })).toBeInTheDocument();
    expect(screen.queryByText(/速度/)).not.toBeInTheDocument();
  });
});