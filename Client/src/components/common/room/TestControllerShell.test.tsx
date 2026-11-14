import type { JSX, ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BotCountRow, TestControllerShell } from "./TestControllerShell";

// 动效库在 jsdom 里会往 style 上写中间帧，逐字比对结构前把 motion.* 换成普通元素，
// 只丢掉动效专用属性，className/style/ref/aria/data 原样保留（办法同 GameLayout.test.tsx）。
vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const MOTION_ONLY = new Set([
    "layout",
    "layoutId",
    "layoutDependency",
    "layoutScroll",
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
    "drag",
    "dragConstraints",
    "dragElastic",
    "dragMomentum",
    "dragPropagation",
    "dragSnapToOrigin",
    "onAnimationStart",
    "onAnimationComplete",
    "onUpdate",
    "onDrag",
    "onDragStart",
    "onDragEnd",
    "onViewportEnter",
    "onViewportLeave",
    "viewport",
    "transformTemplate",
  ]);
  const cache = new Map<string, unknown>();
  const motion = new Proxy({} as Record<string, unknown>, {
    get(_target, tag) {
      if (typeof tag !== "string") return undefined;
      let component = cache.get(tag);
      if (!component) {
        component = ({
          children,
          ...props
        }: { children?: ReactNode } & Record<string, unknown>) => {
          const dom = Object.fromEntries(
            Object.entries(props).filter(([name]) => !MOTION_ONLY.has(name))
          );
          const Tag = tag as keyof JSX.IntrinsicElements;
          return <Tag {...dom}>{children}</Tag>;
        };
        cache.set(tag, component);
      }
      return component;
    },
  });
  return {
    ...actual,
    motion,
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  };
});

// Radix 与 React 的 useId 令牌随组件树位置变化，按出现顺序换成稳定占位符。
const normalizeIds = (html: string) => {
  const seen = new Map<string, string>();
  return html.replace(/_r_[0-9a-z]+_/g, (token) => {
    let placeholder = seen.get(token);
    if (!placeholder) {
      placeholder = `«id${seen.size}»`;
      seen.set(token, placeholder);
    }
    return placeholder;
  });
};

const renderShell = (headerFocusInset: boolean) => {
  const view = render(
    <TestControllerShell
      title="测试控制器"
      bodyClassName="space-y-2 border-t px-4 pb-4 pt-3"
      headerFocusInset={headerFocusInset}
    >
      <p>分组内容</p>
    </TestControllerShell>
  );
  return { html: () => normalizeIds(view.container.firstElementChild!.outerHTML) };
};

const header = () => screen.getByRole("button", { name: /测试控制器/ });

describe("TestControllerShell", () => {
  it("默认展开，聚焦环不内收", () => {
    expect(renderShell(false).html()).toMatchInlineSnapshot(
      `"<div class="w-full max-w-full overflow-hidden floating-surface shadow-lg md:w-96"><button type="button" aria-expanded="true" class="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flask-conical h-4 w-4 text-primary" aria-hidden="true"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"></path><path d="M6.453 15h11.094"></path><path d="M8.5 2h7"></path></svg><span>测试控制器</span><span aria-hidden="true" class="inline-flex ml-auto text-muted-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down h-4 w-4" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></span></button><div class=""><div class="space-y-2 border-t px-4 pb-4 pt-3"><p>分组内容</p></div></div></div>"`
    );
  });

  it("聚焦环内收只多一个类，其余结构不变", () => {
    expect(renderShell(true).html()).toMatchInlineSnapshot(
      `"<div class="w-full max-w-full overflow-hidden floating-surface shadow-lg md:w-96"><button type="button" aria-expanded="true" class="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:-outline-offset-2"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flask-conical h-4 w-4 text-primary" aria-hidden="true"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"></path><path d="M6.453 15h11.094"></path><path d="M8.5 2h7"></path></svg><span>测试控制器</span><span aria-hidden="true" class="inline-flex ml-auto text-muted-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down h-4 w-4" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></span></button><div class=""><div class="space-y-2 border-t px-4 pb-4 pt-3"><p>分组内容</p></div></div></div>"`
    );
  });

  it("收起后内容卸载", () => {
    const { html } = renderShell(true);
    fireEvent.click(header());
    expect(screen.queryByText("分组内容")).toBeNull();
    expect(html()).toMatchInlineSnapshot(
      `"<div class="w-full max-w-full overflow-hidden floating-surface shadow-lg md:w-96"><button type="button" aria-expanded="false" class="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:-outline-offset-2"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flask-conical h-4 w-4 text-primary" aria-hidden="true"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"></path><path d="M6.453 15h11.094"></path><path d="M8.5 2h7"></path></svg><span>测试控制器</span><span aria-hidden="true" class="inline-flex ml-auto text-muted-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down h-4 w-4" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></span></button></div>"`
    );
  });

  it("再点一下回到展开", () => {
    renderShell(false);
    fireEvent.click(header());
    fireEvent.click(header());
    expect(header()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("分组内容")).toBeInTheDocument();
  });

  it("两款的聚焦环口径由参数决定，不写死", () => {
    const flat = render(
      <TestControllerShell title="甲" bodyClassName="a" headerFocusInset={false}>
        <p>甲</p>
      </TestControllerShell>
    );
    expect(screen.getByRole("button", { name: "甲" }).className).not.toContain(
      "focus-visible:-outline-offset-2"
    );
    flat.unmount();

    render(
      <TestControllerShell title="甲" bodyClassName="a" headerFocusInset>
        <p>甲</p>
      </TestControllerShell>
    );
    expect(screen.getByRole("button", { name: "甲" }).className).toContain(
      "focus-visible:-outline-offset-2"
    );
  });
});

const renderRow = (count: number, addPending = false, removePending = false) => {
  const onAdd = vi.fn();
  const onRemove = vi.fn();
  const view = render(
    <BotCountRow
      count={count}
      onAdd={onAdd}
      onRemove={onRemove}
      addPending={addPending}
      removePending={removePending}
    />
  );
  return {
    onAdd,
    onRemove,
    html: () => normalizeIds(view.container.firstElementChild!.outerHTML),
  };
};

describe("BotCountRow", () => {
  it("空闲 · 已有人机", () => {
    expect(renderRow(2).html()).toMatchInlineSnapshot(
      `"<div class="flex items-center gap-1.5"><button type="button" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground rounded-md px-3 h-7 flex-1 gap-1 text-xs" aria-label="移除一个测试人机"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-minus h-3 w-3" aria-hidden="true"><path d="M5 12h14"></path></svg>减一个</button><span class="w-10 text-center text-sm font-medium tabular-nums">2</span><button type="button" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground rounded-md px-3 h-7 flex-1 gap-1 text-xs" aria-label="添加一个测试人机"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus h-3 w-3" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>加一个</button></div>"`
    );
  });

  it("添加中", () => {
    expect(renderRow(2, true).html()).toMatchInlineSnapshot(
      `"<div class="flex items-center gap-1.5"><button type="button" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground rounded-md px-3 h-7 flex-1 gap-1 text-xs" aria-label="移除一个测试人机"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-minus h-3 w-3" aria-hidden="true"><path d="M5 12h14"></path></svg>减一个</button><span class="w-10 text-center text-sm font-medium tabular-nums">2</span><button type="button" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground rounded-md px-3 h-7 flex-1 gap-1 text-xs" disabled="" aria-busy="true" aria-label="添加一个测试人机"><span aria-hidden="true" class="inline-flex size-4 shrink-0 items-center justify-center" data-testid="button-spinner"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 size-full" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus h-3 w-3" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>加一个</button></div>"`
    );
  });

  it("没有人机时减一个禁用，加一个照常", () => {
    const { onAdd, onRemove } = renderRow(0);
    fireEvent.click(screen.getByRole("button", { name: "移除一个测试人机" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "添加一个测试人机" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("在途的那一侧禁用并转圈，另一侧不受影响", () => {
    const { onAdd, onRemove } = renderRow(2, false, true);
    const remove = screen.getByRole("button", { name: "移除一个测试人机" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("aria-busy", "true");
    fireEvent.click(remove);
    expect(onRemove).not.toHaveBeenCalled();

    const add = screen.getByRole("button", { name: "添加一个测试人机" });
    expect(add).toBeEnabled();
    expect(add).not.toHaveAttribute("aria-busy");
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("两侧都空闲时点了各发一次", () => {
    const { onAdd, onRemove } = renderRow(3);
    fireEvent.click(screen.getByRole("button", { name: "移除一个测试人机" }));
    fireEvent.click(screen.getByRole("button", { name: "添加一个测试人机" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
