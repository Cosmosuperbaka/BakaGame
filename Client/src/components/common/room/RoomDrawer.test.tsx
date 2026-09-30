import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { stubMatchMedia } from "@/test/MatchMedia";
import { RoomDrawer } from "./RoomDrawer";

it("侧栏把键盘焦点留在面板内并允许按退出键关闭", async () => {
  const user = userEvent.setup();
  stubMatchMedia(false);
  function Example() {
    const [open, setOpen] = useState(true);
    return <><button>背景操作</button><RoomDrawer open={open} onOpenChange={setOpen} side="right" title="聊天" closeFrom="xl"><input aria-label="聊天消息" /></RoomDrawer></>;
  }
  try {
    render(<Example />);
    await user.click(screen.getByRole("textbox", { name: "聊天消息" }));
    await user.tab();
    expect(screen.getByRole("button", { name: "关闭面板" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "背景操作" })).toBeInTheDocument();
  } finally { vi.unstubAllGlobals(); }
});

it("视口放大到面板常驻的断点时自动关闭覆盖面板", async () => {
  const media = stubMatchMedia(false);
  function Example() {
    const [open, setOpen] = useState(true);
    return <RoomDrawer open={open} onOpenChange={setOpen} side="left" title="玩家" closeFrom="md"><p>玩家内容</p></RoomDrawer>;
  }
  try {
    render(<Example />);
    expect(screen.getByRole("dialog", { name: "玩家" })).toBeInTheDocument();
    media.crossBreakpoint(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  } finally { vi.unstubAllGlobals(); }
});
