import { useState, type ReactElement, type ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { stubMatchMedia } from "@/test/MatchMedia";
import { RoomDrawer } from "./RoomDrawer";
import { RoomShell } from "./RoomShell";
import { Users } from "lucide-react";

// 动画在 jsdom 里会往 style 上写中间帧，逐字比对结构时先换成普通元素。
// AnimatePresence 保留真身：没有 motion 子节点登记退场时它立刻卸载并回调 onExitComplete，
// 依赖退场时序的既有用例照旧成立。
vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  const MOTION_ONLY = new Set([
    "layout",
    "layoutId",
    "variants",
    "initial",
    "animate",
    "exit",
    "transition",
    "custom",
    "whileHover",
    "whileTap",
    "whileFocus",
    "whileDrag",
    "whileInView",
  ]);
  type PlainProps = { children?: ReactNode } & Record<string, unknown>;
  const cache = new Map<string, (props: PlainProps) => ReactElement>();
  const plain = (tag: string) => {
    const Tag = tag as "div";
    return ({ children, ...props }: PlainProps) => (
      <Tag
        {...Object.fromEntries(Object.entries(props).filter(([name]) => !MOTION_ONLY.has(name)))}
      >
        {children}
      </Tag>
    );
  };
  return {
    ...actual,
    motion: new Proxy(
      {},
      {
        get: (_target, tag: string) => {
          let component = cache.get(tag);
          if (!component) {
            component = plain(tag);
            cache.set(tag, component);
          }
          return component;
        },
      }
    ),
  };
});

it("侧栏把键盘焦点留在面板内并允许按退出键关闭", async () => {
  const user = userEvent.setup();
  stubMatchMedia(false);
  function Example() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button>背景操作</button>
        <RoomDrawer open={open} onOpenChange={setOpen} side="right" title="聊天" closeFrom="xl">
          <input aria-label="聊天消息" />
        </RoomDrawer>
      </>
    );
  }
  try {
    render(<Example />);
    await user.click(screen.getByRole("textbox", { name: "聊天消息" }));
    await user.tab();
    expect(screen.getByRole("button", { name: "关闭面板" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "背景操作" })).toBeInTheDocument();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("视口放大到面板常驻的断点时自动关闭覆盖面板", async () => {
  const media = stubMatchMedia(false);
  function Example() {
    const [open, setOpen] = useState(true);
    return (
      <RoomDrawer open={open} onOpenChange={setOpen} side="left" title="玩家" closeFrom="md">
        <p>玩家内容</p>
      </RoomDrawer>
    );
  }
  try {
    render(<Example />);
    expect(screen.getByRole("dialog", { name: "玩家" })).toBeInTheDocument();
    media.crossBreakpoint(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  } finally {
    vi.unstubAllGlobals();
  }
});

function ShellExample() {
  const [openDrawer, setOpenDrawer] = useState<string | null>(null);
  return (
    <RoomShell
      title="测试房"
      onLeave={() => {}}
      game={<button>游戏操作</button>}
      drawers={[
        {
          key: "players",
          icon: Users,
          label: "玩家列表",
          title: "玩家",
          side: "left",
          closeFrom: "md",
          content: <input aria-label="面板输入" />,
        },
      ]}
      openDrawer={openDrawer}
      onDrawerChange={setOpenDrawer}
    />
  );
}

it.each(["关闭按钮", "退出键", "背板"])("真实外壳经%s关闭后回到打开入口", async (method) => {
  const user = userEvent.setup();
  stubMatchMedia(false);
  try {
    render(<ShellExample />);
    const trigger = screen.getByRole("button", { name: "玩家列表" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "玩家" })).toBeInTheDocument();
    if (method === "关闭按钮") await user.click(screen.getByRole("button", { name: "关闭面板" }));
    else if (method === "退出键") await user.keyboard("{Escape}");
    else {
      // Radix 的非 Portal Overlay 是房间主体背板，模拟其真实 pointer 关闭路径。
      const dialog = screen.getByRole("dialog");
      const overlay = dialog.previousElementSibling;
      if (!(overlay instanceof HTMLElement)) throw new Error("缺少抽屉背板");
      await user.click(overlay);
    }
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  } finally {
    vi.unstubAllGlobals();
  }
});
it("断点关闭不恢复到已隐藏入口，而回到常驻离开按钮", async () => {
  const user = userEvent.setup();
  const media = stubMatchMedia(false);
  try {
    render(<ShellExample />);
    await user.click(screen.getByRole("button", { name: "玩家列表" }));
    media.crossBreakpoint(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "离开房间" })).toHaveFocus());
  } finally {
    vi.unstubAllGlobals();
  }
});

it("抽屉打开时顶栏对读屏与指针都不可达，关掉面板后恢复可达", async () => {
  const user = userEvent.setup();
  const onLeave = vi.fn();
  stubMatchMedia(false);
  function ShellWithDrawerOpen() {
    const [openDrawer, setOpenDrawer] = useState<string | null>("players");
    return (
      <RoomShell
        title="测试房"
        onLeave={onLeave}
        game={<button>游戏操作</button>}
        drawers={[
          {
            key: "players",
            icon: Users,
            label: "玩家列表",
            title: "玩家",
            side: "left",
            closeFrom: "md",
            content: <input aria-label="面板输入" />,
          },
        ]}
        openDrawer={openDrawer}
        onDrawerChange={setOpenDrawer}
      />
    );
  }
  try {
    render(<ShellWithDrawerOpen />);
    expect(screen.getByRole("dialog", { name: "玩家" })).toBeInTheDocument();
    const leave = document.querySelector<HTMLElement>('[aria-label="离开房间"]');
    if (!leave) throw new Error("顶栏缺少离开房间按钮");

    // 抽屉是 modal 面板：不用 Portal 只保证视觉上顶栏不被遮挡，语义上顶栏整片被划出无障碍树，
    // 指针事件也被 body 关掉。先离场路径是「关面板 → 点离开」，代码与文案都不能说「始终可点」。
    expect(leave.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(document.body.style.pointerEvents).toBe("none");
    expect(onLeave).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "关闭面板" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(leave.closest('[aria-hidden="true"]')).toBeNull();
    await waitFor(() => expect(document.body.style.pointerEvents).toBe(""));
    await user.click(leave);
    expect(onLeave).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

function DrawerHarness({ side }: { side: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <RoomDrawer open={open} onOpenChange={setOpen} side={side} title="玩家" closeFrom="md">
        <p>面板内容</p>
      </RoomDrawer>
    </div>
  );
}

describe("RoomDrawer 渲染结构", () => {
  const openDrawer = async (side: "left" | "right") => {
    const user = userEvent.setup();
    render(<DrawerHarness side={side} />);
    await user.click(screen.getByRole("button", { name: "打开" }));
    await screen.findByRole("dialog", { name: "玩家" });
  };

  it("关闭时背板与面板都不进 DOM", () => {
    stubMatchMedia(false);
    try {
      render(<DrawerHarness side="left" />);
      expect(document.body.innerHTML).toMatchInlineSnapshot(
        `"<div><div><button type="button">打开</button></div></div>"`
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("左侧打开时背板与面板的类名与属性逐字不变", async () => {
    stubMatchMedia(false);
    try {
      await openDrawer("left");
      expect(document.body.innerHTML).toMatchInlineSnapshot(
        `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div><div><button type="button" data-aria-hidden="true" aria-hidden="true">打开</button><div class="scrim absolute inset-0 z-drawer" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><aside class="absolute inset-y-0 z-drawer flex min-w-0 max-w-full flex-col overflow-hidden bg-panel shadow-lg left-0 border-r [--tw-ring-shadow:-1rem_0_0_0_var(--color-panel)] w-72" role="dialog" id="radix-_r_16_" data-state="open" tabindex="-1" aria-labelledby="radix-_r_17_" style="pointer-events: auto;"><div class="flex h-12 shrink-0 items-center gap-3 border-b pl-4 pr-2"><h2 id="radix-_r_17_" class="min-w-0 flex-1 truncate text-sm font-semibold">玩家</h2><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground" aria-label="关闭面板"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div><div class="min-h-0 flex-1"><p>面板内容</p></div></aside></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("右侧打开时背板与面板的类名与属性逐字不变", async () => {
    stubMatchMedia(false);
    try {
      await openDrawer("right");
      expect(document.body.innerHTML).toMatchInlineSnapshot(
        `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div><div><button type="button" data-aria-hidden="true" aria-hidden="true">打开</button><div class="scrim absolute inset-0 z-drawer" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><aside class="absolute inset-y-0 z-drawer flex min-w-0 max-w-full flex-col overflow-hidden bg-panel shadow-lg right-0 border-l [--tw-ring-shadow:1rem_0_0_0_var(--color-panel)] w-80" role="dialog" id="radix-_r_1b_" data-state="open" tabindex="-1" aria-labelledby="radix-_r_1c_" style="pointer-events: auto;"><div class="flex h-12 shrink-0 items-center gap-3 border-b pl-4 pr-2"><h2 id="radix-_r_1c_" class="min-w-0 flex-1 truncate text-sm font-semibold">玩家</h2><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground" aria-label="关闭面板"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div><div class="min-h-0 flex-1"><p>面板内容</p></div></aside></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
