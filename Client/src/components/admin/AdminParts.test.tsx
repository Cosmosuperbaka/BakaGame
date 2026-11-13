import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./AdminParts";

describe("ConfirmDialog", () => {
  it("确认回调抛错时忙碌态复位，显示失败原因，仍可重试与取消", async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(null);
    const onOpenChange = vi.fn();
    const events = userEvent.setup();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="关闭房间"
        description="确定？"
        confirmLabel="确认关闭"
        onConfirm={onConfirm}
      />
    );
    await events.click(screen.getByRole("button", { name: "确认关闭" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // 忙碌态已复位：取消可点，确认可再点。
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "确认关闭" })).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await events.click(screen.getByRole("button", { name: "确认关闭" }));
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("关闭确认框后焦点回到打开它的按钮", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开
          </button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="标题"
            description="说明"
            confirmLabel="确认"
            onConfirm={() => Promise.resolve(null)}
          />
        </>
      );
    }
    const events = userEvent.setup();
    render(<Host />);
    await events.click(screen.getByRole("button", { name: "打开" }));
    await events.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "打开" })).toHaveFocus();
  });
});
