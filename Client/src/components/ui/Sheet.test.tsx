import { useState, type ReactElement, type ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

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

describe("Sheet 渲染结构", () => {
  it("关闭时面板不进 DOM", () => {
    render(<Harness />);
    expect(document.body.innerHTML).toMatchInlineSnapshot(
      `"<div><div><button type="button">打开</button></div></div>"`
    );
  });

  it("打开时遮罩与面板的类名与属性逐字不变", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "打开" }));
    await screen.findByRole("dialog", { name: "许可证" });
    expect(document.body.innerHTML).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"><div><button type="button">打开</button></div></div><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><aside class="fixed inset-y-0 z-modal flex w-[min(92vw,32rem)] max-w-full flex-col overflow-hidden border bg-popover text-popover-foreground shadow-lg right-0 border-l [--tw-ring-shadow:1rem_0_0_0_var(--color-popover)]" role="dialog" id="radix-_r_i_" data-state="open" tabindex="-1" aria-labelledby="radix-_r_j_" style="pointer-events: auto;"><div class="flex h-12 shrink-0 items-center gap-3 border-b pl-4 pr-2"><h2 id="radix-_r_j_" class="min-w-0 flex-1 truncate text-sm font-semibold">许可证</h2><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground" aria-label="关闭面板"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div><div class="scrollbar-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"><p>面板内容</p></div></aside><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });
});
