import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DotSeparated } from "./DotSeparated";

describe("DotSeparated", () => {
  it("项之间补空格，间隔号跟在前一项后面，最后一项不带", () => {
    const { container } = render(
      <p>
        <DotSeparated items={["甲", "乙", "丙"]} itemClassName="whitespace-nowrap" />
      </p>
    );
    expect(container.textContent).toBe("甲 · 乙 · 丙");
    const spans = [...container.querySelectorAll("span")];
    expect(spans.map((span) => span.textContent)).toEqual(["甲 ·", "乙 ·", "丙"]);
    expect(spans.every((span) => span.classList.contains("whitespace-nowrap"))).toBe(true);
  });

  it("只有一项时不带间隔号", () => {
    const { container } = render(<DotSeparated items={["独项"]} itemClassName="x" />);
    expect(container.textContent).toBe("独项");
  });
});
