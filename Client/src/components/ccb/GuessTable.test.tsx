import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { GuessTable } from "@/components/ccb/GuessTable";
import type { CCBFeedback, CCBGuessRecord } from "@/types";

const feedback = (overrides: Partial<CCBFeedback> = {}): CCBFeedback => ({
  gender: { guess: "female", feedback: "yes" },
  popularity: { guess: 120, feedback: "=" },
  rating: { guess: 8, feedback: "=" },
  shared_appearances: { first: "A", firstOriginal: "A", firstCn: "甲", count: 0 },
  appearancesCount: { guess: 3, feedback: "=" },
  metaTags: { guess: ["紫瞳"], shared: [] },
  latestAppearance: { guess: 2010, feedback: "=" },
  earliestAppearance: { guess: 2008, feedback: "=" },
  ...overrides,
});

const guess = (overrides: Partial<CCBGuessRecord> = {}): CCBGuessRecord => ({
  characterId: 1,
  characterName: "アルファ",
  characterNameCn: "阿尔法",
  submittedAt: 1_700_000_000_000,
  correct: false,
  feedback: feedback(),
  ...overrides,
});

describe("GuessTable 渲染", () => {
  test("偏高给 ↓、偏低给 ↑（方向与数值高低相反）", () => {
    render(
      <GuessTable
        guesses={[
          guess({
            feedback: feedback({
              popularity: { guess: 300, feedback: "+" },
              rating: { guess: 9, feedback: "-" },
            }),
          }),
        ]}
      />,
    );

    expect(screen.getByText("↓")).toBeInTheDocument();
    expect(screen.getByText("↑")).toBeInTheDocument();
  });

  test("无有效作品时最高分显示「无」", () => {
    render(
      <GuessTable
        guesses={[guess({ feedback: feedback({ rating: { guess: -1, feedback: "?" } }) })]}
      />,
    );

    expect(screen.getByText("无")).toBeInTheDocument();
  });

  test("共同作品优先中文名，多于一个时补 +N", () => {
    render(
      <GuessTable
        guesses={[
          guess({
            feedback: feedback({
              shared_appearances: {
                first: "A",
                firstOriginal: "A",
                firstCn: "甲",
                count: 3,
              },
            }),
          }),
        ]}
      />,
    );

    expect(screen.getByText("甲 +2")).toBeInTheDocument();
  });

  test("空列表给出占位文案", () => {
    render(<GuessTable guesses={[]} />);
    expect(screen.getByText("还没有猜测记录")).toBeInTheDocument();
  });
});
