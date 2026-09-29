import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CreateRoomDialog } from "./CreateRoomDialog";

describe("CreateRoomDialog", () => {
  it("私密房缺密码时标红密码框并关联错误说明，输入后解除", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    render(<CreateRoomDialog open onOpenChange={() => {}} defaultName="测试房间" onCreate={onCreate} />);

    await user.click(screen.getByRole("switch", { name: "私密房间" }));
    const password = await screen.findByLabelText("房间密码");
    expect(password).not.toHaveAttribute("aria-invalid");

    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("私密房间需要设置密码");
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password).toHaveAccessibleDescription("私密房间需要设置密码");
    expect(onCreate).not.toHaveBeenCalled();

    await user.type(password, "1234");
    expect(password).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
