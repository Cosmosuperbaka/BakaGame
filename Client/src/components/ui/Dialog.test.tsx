import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./Dialog";

/** jsdom 不做布局：给浮层一个固定的盒子，来源换算才有可测的输入。 */
const BOX = { width: 400, height: 200, left: 100, top: 100 };

function Harness({ origin }: { origin: { x: number; y: number } | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <Dialog open={open} onOpenChange={setOpen} origin={origin}>
        <DialogContent>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>说明</DialogDescription>
        </DialogContent>
      </Dialog>
    </>
  );
}

describe("Dialog 来源锚定", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(BOX.width);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(BOX.height);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      ...BOX,
      x: BOX.left,
      y: BOX.top,
      right: BOX.left + BOX.width,
      bottom: BOX.top + BOX.height,
      toJSON: () => ({}),
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("传了来源时缩放原点落在来源点上（浮层渲染在 Portal 里也要生效）", async () => {
    const user = userEvent.setup();
    // 来源在浮层右上角外侧：x 超出右缘一半宽度，y 在上缘上方。
    render(<Harness origin={{ x: 700, y: 50 }} />);

    await user.click(screen.getByRole("button", { name: "打开" }));
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(dialog.style.transformOrigin).toBe("150.00% -25.00%");
  });

  it("没有来源时围绕自身中心缩放", async () => {
    const user = userEvent.setup();
    render(<Harness origin={null} />);

    await user.click(screen.getByRole("button", { name: "打开" }));
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(dialog.style.transformOrigin).toBe("50% 50%");
  });
});
