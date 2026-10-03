import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { stubMatchMedia } from "@/test/MatchMedia";
import { RoomDrawer } from "./RoomDrawer";
import { RoomShell } from "./RoomShell";
import { Users } from "lucide-react";

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

function ShellExample() {
  const [openDrawer, setOpenDrawer] = useState<string | null>(null);
  return <RoomShell title="测试房" onLeave={() => {}} game={<button>游戏操作</button>}
    drawers={[{key:"players",icon:Users,label:"玩家列表",title:"玩家",side:"left",closeFrom:"md",content:<input aria-label="面板输入"/>}]}
    openDrawer={openDrawer} onDrawerChange={setOpenDrawer}/>;
}

it.each(["关闭按钮", "退出键", "背板"])("真实外壳经%s关闭后回到打开入口", async (method) => {
  const user=userEvent.setup();stubMatchMedia(false);
  try {
    render(<ShellExample/>);
    const trigger=screen.getByRole("button",{name:"玩家列表"});await user.click(trigger);
    expect(screen.getByRole("dialog",{name:"玩家"})).toBeInTheDocument();
    if(method==="关闭按钮") await user.click(screen.getByRole("button",{name:"关闭面板"}));
    else if(method==="退出键") await user.keyboard("{Escape}");
    else {
      // Radix 的非 Portal Overlay 是房间主体背板，模拟其真实 pointer 关闭路径。
      const dialog=screen.getByRole("dialog");const overlay=dialog.previousElementSibling;
      if (!(overlay instanceof HTMLElement)) throw new Error("缺少抽屉背板");
      await user.click(overlay);
    }
    await waitFor(()=>expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(()=>expect(trigger).toHaveFocus());
  } finally {vi.unstubAllGlobals();}
});
it("断点关闭不恢复到已隐藏入口，而回到常驻离开按钮", async()=>{
  const user=userEvent.setup();const media=stubMatchMedia(false);
  try {
    render(<ShellExample/>);await user.click(screen.getByRole("button",{name:"玩家列表"}));
    media.crossBreakpoint(true);
    await waitFor(()=>expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(()=>expect(screen.getByRole("button",{name:"离开房间"})).toHaveFocus());
  } finally {vi.unstubAllGlobals();}
});
