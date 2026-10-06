import { render, screen, waitFor } from "@testing-library/react";
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

  it("不在大厅显示的房间不要密码，切换含义后开关回到关闭", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    const view = render(<CreateRoomDialog open onOpenChange={() => {}} defaultName="测试房间" privacy="unlisted" onCreate={onCreate} />);

    const unlisted = screen.getByRole("switch", { name: "不在大厅显示" });
    expect(unlisted).toHaveAccessibleDescription("开启后不在大厅列出，凭链接仍可进入。");
    await user.click(unlisted);
    expect(screen.queryByLabelText("房间密码")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ visibility: "private", password: undefined }));

    // 换到有密码机制的服务器：上一种「私密」不沿用，否则会带着未填的密码直接报错。
    view.rerender(<CreateRoomDialog open onOpenChange={() => {}} defaultName="测试房间" privacy="password" onCreate={onCreate} />);
    expect(screen.getByRole("switch", { name: "私密房间" })).not.toBeChecked();
  });

  it("房间类型开关常驻说明，不可用时禁用并改写为原因", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    const mode = { label: "兼容原版", description: "开启后建在原版服务器上。", checked: false, onCheckedChange };
    const view = render(<CreateRoomDialog open onOpenChange={() => {}} defaultName="测试房间" roomMode={mode} onCreate={vi.fn(async () => {})} />);
    // 开关排在名称前面，打开时焦点仍落在名称上。
    await waitFor(() => expect(screen.getByLabelText("房间名称")).toHaveFocus());
    const toggle = screen.getByRole("switch", { name: "兼容原版" });
    expect(toggle).toHaveAccessibleDescription("开启后建在原版服务器上。");
    await user.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    view.rerender(<CreateRoomDialog open onOpenChange={() => {}} defaultName="测试房间" roomMode={{ ...mode, disabledReason: "原版服务器暂未接入。" }} onCreate={vi.fn(async () => {})} />);
    expect(screen.getByRole("switch", { name: "兼容原版" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "兼容原版" })).toHaveAccessibleDescription("原版服务器暂未接入。");
  });

  it("房间名称按服务器上限截断，超长的默认名称不会被服务端拒绝", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    const view = render(<CreateRoomDialog open onOpenChange={() => {}} defaultName={"长".repeat(35)} nameMaxLength={32} onCreate={onCreate} />);

    const name = screen.getByRole("textbox", { name: "房间名称" });
    expect(name).toHaveAttribute("maxLength", "32");
    expect(name).toHaveValue("长".repeat(32));

    // 换到上限更小的服务器：输入框已有的字不会被浏览器裁掉，提交时按当前上限截断。
    view.rerender(<CreateRoomDialog open onOpenChange={() => {}} defaultName={"长".repeat(35)} nameMaxLength={30} onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "长".repeat(30) }));
  });

  it("不能禁止观战时旁观开关恒为开，与提交值一致", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    const view = render(<CreateRoomDialog open onOpenChange={() => {}} defaultName="测试房间" onCreate={onCreate} />);
    await user.click(screen.getByRole("switch", { name: "允许旁观" }));
    expect(screen.getByRole("switch", { name: "允许旁观" })).not.toBeChecked();

    view.rerender(<CreateRoomDialog open onOpenChange={() => {}} defaultName="测试房间" spectatorsDisabledReason="原版房间不允许禁止观战" onCreate={onCreate} />);
    const spectators = screen.getByRole("switch", { name: "允许旁观" });
    expect(spectators).toBeChecked();
    expect(spectators).toHaveAccessibleDescription("原版房间不允许禁止观战");
    await user.click(screen.getByRole("button", { name: "创建" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ allowSpectators: true }));
  });
});
