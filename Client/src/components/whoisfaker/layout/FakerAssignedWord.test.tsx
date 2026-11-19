import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { wordDock } from "@/lib/motion/NamedMoves";
import { FakerAssignedWord } from "./FakerAssignedWord";

/** 单行排开时的自然宽度：约等于九个大字加内边距。 */
const SINGLE_LINE = 446;

/**
 * jsdom 不排版：按元素当前的行内样式回答尺寸。单行（nowrap 或未限宽）取整行宽，
 * 限宽时取限宽并按两行算高度，足以驱动「中栏放不下就折行」的分支。
 */
function stubLayout() {
  const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.style.whiteSpace === "nowrap" || !this.style.maxWidth) return SINGLE_LINE;
    return Number.parseInt(this.style.maxWidth, 10);
  });
  const height = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.style.maxWidth && this.style.whiteSpace !== "nowrap" ? 120 : 60;
    });
  return () => {
    width.mockRestore();
    height.mockRestore();
  };
}

function anchorOfWidth(width: number) {
  const anchor = document.createElement("span");
  anchor.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height: 20, right: width, bottom: 20, x: 0, y: 0 }) as DOMRect;
  document.body.appendChild(anchor);
  const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
  ref.current = anchor;
  return ref;
}

describe("FakerAssignedWord 停靠位放不下时折行", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = stubLayout();
  });
  afterEach(() => {
    restore();
    document.body.innerHTML = "";
  });

  function renderWord(anchorWidth: number) {
    const onDockSizeChange = vi.fn();
    render(
      <FakerAssignedWord
        word="白板提示：一种面食"
        revealed={false}
        anchorRef={anchorOfWidth(anchorWidth)}
        stageRef={createRef<HTMLElement>()}
        onDockSizeChange={onDockSizeChange}
      />
    );
    const word = screen.getByText("白板提示：一种面食");
    return { box: word.parentElement!, text: word, onDockSizeChange };
  }

  it("中栏比单行窄：按中栏宽度折行、至多两行，停靠位仍按单行宽度申请", () => {
    const { box, text, onDockSizeChange } = renderWord(100);
    expect(box.style.maxWidth).toBe(`${Math.floor(100 / wordDock.scale)}px`);
    expect(text).toHaveClass("line-clamp-2");
    expect(onDockSizeChange).toHaveBeenLastCalledWith({
      width: Math.ceil(SINGLE_LINE * wordDock.scale),
      height: Math.ceil(120 * wordDock.scale),
    });
  });

  it("中栏放得下单行：不限宽、不折行", () => {
    const { box, text } = renderWord(Math.ceil(SINGLE_LINE * wordDock.scale));
    expect(box.style.maxWidth).toBe("");
    expect(text).not.toHaveClass("line-clamp-2");
  });
});
