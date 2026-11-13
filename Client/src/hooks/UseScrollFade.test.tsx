import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useScrollFade } from "./UseScrollFade";

function Scroller({ axis }: { axis: "x" | "y" }) {
  const [, ref] = useScrollFade<HTMLDivElement>(axis);
  return (
    <div ref={ref} data-testid="scroller">
      <p>内容</p>
    </div>
  );
}

/** jsdom 不排版：手动给出滚动区的内容长度与视口长度。 */
function sized(node: HTMLElement, content: number, viewport: number) {
  for (const [name, value] of [
    ["scrollHeight", content],
    ["clientHeight", viewport],
    ["scrollWidth", content],
    ["clientWidth", viewport],
  ] as const) {
    Object.defineProperty(node, name, { configurable: true, value });
  }
}

const start = (node: HTMLElement) => node.style.getPropertyValue("--scroll-fade-start");
const end = (node: HTMLElement) => node.style.getPropertyValue("--scroll-fade-end");

describe("useScrollFade", () => {
  it("停在顶端且下方还有内容：只收起顶端的淡出", () => {
    render(<Scroller axis="y" />);
    const node = screen.getByTestId("scroller");
    sized(node, 900, 300);
    fireEvent.scroll(node);
    expect(start(node)).toBe("0px");
    expect(end(node)).toBe("");
  });

  it("滚到中段两头都淡出，滚到底收起底端", () => {
    render(<Scroller axis="y" />);
    const node = screen.getByTestId("scroller");
    sized(node, 900, 300);
    node.scrollTop = 200;
    fireEvent.scroll(node);
    expect([start(node), end(node)]).toEqual(["", ""]);
    node.scrollTop = 600;
    fireEvent.scroll(node);
    expect([start(node), end(node)]).toEqual(["", "0px"]);
  });

  it("放得下时两头都不淡出；横向按左右算", () => {
    render(<Scroller axis="x" />);
    const node = screen.getByTestId("scroller");
    sized(node, 300, 300);
    fireEvent.scroll(node);
    expect([start(node), end(node)]).toEqual(["0px", "0px"]);
    sized(node, 500, 300);
    node.scrollLeft = 200;
    fireEvent.scroll(node);
    expect([start(node), end(node)]).toEqual(["", "0px"]);
  });
});
