import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

function Harness({ onExitComplete }: { onExitComplete?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="许可证" onExitComplete={onExitComplete}>
        <p>面板内容</p>
      </Sheet>
    </div>
  );
}

describe("Sheet", () => {
  it("以标题命名对话框，内容渲染在面板里", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "打开" }));
    const dialog = await screen.findByRole("dialog", { name: "许可证" });
    expect(within(dialog).getByText("面板内容")).toBeInTheDocument();
  });

  it("退出动画播完才卸载并回调 onExitComplete，焦点回到打开它的按钮", async () => {
    const user = userEvent.setup();
    const onExitComplete = vi.fn();
    render(<Harness onExitComplete={onExitComplete} />);
    const trigger = screen.getByRole("button", { name: "打开" });

    await user.click(trigger);
    await screen.findByRole("dialog", { name: "许可证" });
    await user.click(screen.getByRole("button", { name: "关闭面板" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onExitComplete).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });

  it("按 Esc 关闭面板", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "打开" }));
    await screen.findByRole("dialog", { name: "许可证" });
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
