import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OutcomeLine, VoteRow } from "./FakerVoteLines";

describe("OutcomeLine", () => {
  it("有平票候选时只说平票进入 PK", () => {
    render(<OutcomeLine names={["丙"]} empty="无人出局" tieBreak={["甲", "乙"]} />);
    expect(screen.getByText("甲、乙")).toHaveClass("text-warning");
    expect(screen.getByText(/平票，进入 PK/)).toBeInTheDocument();
    expect(screen.queryByText("丙")).toBeNull();
  });

  it("有出局者时点名，没有时给各自的说法", () => {
    const { rerender } = render(<OutcomeLine names={["甲", "乙"]} empty="平安夜，无人出局" />);
    expect(screen.getByText("甲、乙")).toHaveClass("text-destructive");
    rerender(<OutcomeLine names={[]} empty="平安夜，无人出局" />);
    expect(screen.getByText("平安夜，无人出局")).toBeInTheDocument();
  });

  it("两档字号只在大小与对齐上不同", () => {
    const { container, rerender } = render(<OutcomeLine names={["甲"]} empty="" size="base" />);
    expect(container.firstChild).toHaveClass("text-base", "text-center");
    rerender(<OutcomeLine names={["甲"]} empty="" />);
    expect(container.firstChild).toHaveClass("text-xs");
    expect(container.firstChild).not.toHaveClass("text-center");
  });
});

describe("VoteRow", () => {
  it("弃票这类没有收件人的结论压低强调，两档密度只差字号", () => {
    const { container, rerender } = render(
      <ul>
        <VoteRow actor="甲" verb="选择" target="弃票" muted />
      </ul>
    );
    expect(screen.getByText("弃票")).toHaveClass("text-muted-foreground");
    expect(container.querySelector("li")).toHaveClass("text-sm");
    rerender(
      <ul>
        <VoteRow actor="甲" verb="投给" target="乙" dense />
      </ul>
    );
    expect(screen.getByText("乙")).toHaveClass("font-medium");
    expect(container.querySelector("li")).toHaveClass("text-xs");
  });
});
