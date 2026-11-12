import { AnimatePresence, motion } from "framer-motion";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PresenceBoundary } from "./PresenceBoundary";

/** 首屏就在的容器（AnimatePresence initial={false} 的首个子项），里面的条目随后追加。 */
function Board({ items, bounded }: { items: string[]; bounded: boolean }) {
  const list = items.map((item) => (
    <motion.div key={item} data-testid={item} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      {item}
    </motion.div>
  ));
  return (
    <AnimatePresence initial={false}>
      <motion.section key="board" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        {bounded ? <PresenceBoundary>{list}</PresenceBoundary> : list}
      </motion.section>
    </AnimatePresence>
  );
}

// 入场被跳过的元素挂载即是终值（opacity 1）；照常入场的元素挂载时停在起点（opacity 0），之后才补间。
const opacityOf = (id: string) => screen.getByTestId(id).style.opacity;

describe("PresenceBoundary", () => {
  it("首屏已有的条目照旧跳过入场，之后追加的条目从起点入场", () => {
    const { rerender } = render(<Board items={["甲"]} bounded />);
    expect(opacityOf("甲")).toBe("1");

    rerender(<Board items={["甲", "乙"]} bounded />);
    expect(opacityOf("乙")).toBe("0");
  });

  it("不加边界时追加的条目也被当成首屏、直接出现（边界要修的正是这一点）", () => {
    const { rerender } = render(<Board items={["甲"]} bounded={false} />);
    rerender(<Board items={["甲", "乙"]} bounded={false} />);
    expect(opacityOf("乙")).toBe("1");
  });
});
