import { useState, type ReactElement, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./Dialog";

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

describe("Dialog 渲染结构", () => {
  it("关闭时浮层不进 DOM", () => {
    render(<Harness origin={null} />);
    expect(document.body.innerHTML).toMatchInlineSnapshot(
      `"<div><button type="button">打开</button></div>"`
    );
  });

  it("打开时遮罩与窗口自成一层，类名与属性逐字不变", async () => {
    const user = userEvent.setup();
    render(<Harness origin={null} />);

    await user.click(screen.getByRole("button", { name: "打开" }));
    await screen.findByRole("dialog", { name: "设置" });
    expect(document.body.innerHTML).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"><button type="button">打开</button></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-_r_d_" data-state="open" tabindex="-1" aria-labelledby="radix-_r_e_" aria-describedby="radix-_r_f_"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><h2 id="radix-_r_e_" class="text-lg font-semibold leading-none">设置</h2><p id="radix-_r_f_" class="text-sm text-muted-foreground">说明</p></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });
});
