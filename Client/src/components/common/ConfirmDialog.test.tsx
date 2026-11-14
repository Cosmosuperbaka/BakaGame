import { useState, type JSX, type ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

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

// Radix 与 React 的 useId 令牌（`radix-_r_x_`、`_r_x_`）随组件树位置变化，重构加一层壳就会换值；
// 按出现顺序换成稳定占位符，既去掉抖动又保留 id 与 aria-labelledby/describedby/for 的对应关系。
const bodyHtml = () => {
  const seen = new Map<string, string>();
  return document.body.innerHTML.replace(/_r_[0-9a-z]+_/g, (token) => {
    let placeholder = seen.get(token);
    if (!placeholder) {
      placeholder = `«id${seen.size}»`;
      seen.set(token, placeholder);
    }
    return placeholder;
  });
};

describe("确认弹窗渲染结果逐字快照", () => {
  it("管理端：打开", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="关闭房间"
        description="关闭「测试房间」？房内玩家会收到房间已关闭的通知。"
        confirmLabel="关闭房间"
        onConfirm={vi.fn()}
      />
    );
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">关闭房间</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">关闭「测试房间」？房内玩家会收到房间已关闭的通知。</p></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">取消</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-destructive-solid text-destructive-foreground shadow-sm hover:bg-destructive-solid/90 focus-visible:outline-offset-2 h-9 px-4 py-2">关闭房间</button></div></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });

  it("管理端：关闭", () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={vi.fn()}
        title="关闭房间"
        description="关闭「测试房间」？房内玩家会收到房间已关闭的通知。"
        confirmLabel="关闭房间"
        onConfirm={vi.fn()}
      />
    );
    expect(bodyHtml()).toMatchInlineSnapshot(`"<div></div>"`);
  });

  it("管理端：正向操作不用危险色", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="授予管理员"
        description="授予后对方可以进入管理后台。"
        confirmLabel="授予"
        destructive={false}
        onConfirm={vi.fn()}
      />
    );
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">授予管理员</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">授予后对方可以进入管理后台。</p></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">取消</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2">授予</button></div></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });

  it("管理端：请求在途", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="关闭房间"
        description="关闭「测试房间」？房内玩家会收到房间已关闭的通知。"
        confirmLabel="关闭房间"
        onConfirm={() => new Promise<string | null>(() => {})}
      />
    );
    await user.click(screen.getByRole("button", { name: "关闭房间" }));
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">关闭房间</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">关闭「测试房间」？房内玩家会收到房间已关闭的通知。</p></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2" disabled="">取消</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-destructive-solid text-destructive-foreground shadow-sm hover:bg-destructive-solid/90 focus-visible:outline-offset-2 h-9 px-4 py-2" disabled="" aria-busy="true"><span aria-hidden="true" class="inline-flex size-4 shrink-0 items-center justify-center" data-testid="button-spinner"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 size-full" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span>关闭房间</button></div></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });

  it("管理端：确认失败后文案留在弹窗内", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="删除状态事件"
        description="确定删除「测试事件」？"
        confirmLabel="删除"
        onConfirm={async () => "删除失败，请稍后重试"}
      />
    );
    await user.click(screen.getByRole("button", { name: "删除" }));
    await screen.findByRole("alert");
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">删除状态事件</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">确定删除「测试事件」？</p></div><p role="alert" class="flex items-start gap-1.5 text-xs leading-relaxed text-destructive"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-alert lucide-alert-circle mt-0.5 size-3.5 shrink-0" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" x2="12" y1="8" y2="12"></line><line x1="12" x2="12.01" y1="16" y2="16"></line></svg><span class="min-w-0">删除失败，请稍后重试</span></p><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">取消</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-destructive-solid text-destructive-foreground shadow-sm hover:bg-destructive-solid/90 focus-visible:outline-offset-2 h-9 px-4 py-2">删除</button></div></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });

  it("CEE：打开", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="取消本局？"
        description="取消后本局作废，所有玩家回到等待页。"
        cancelLabel="继续本局"
        confirmLabel="确认取消"
        busy={false}
        agentControlPrefix="cee.dialog"
        onConfirm={vi.fn()}
      />
    );
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">取消本局？</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">取消后本局作废，所有玩家回到等待页。</p></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2" data-agent-control="cee.dialog.cancel">继续本局</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-destructive-solid text-destructive-foreground shadow-sm hover:bg-destructive-solid/90 focus-visible:outline-offset-2 h-9 px-4 py-2" data-agent-control="cee.dialog.confirm">确认取消</button></div></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });

  it("CEE：关闭", () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={vi.fn()}
        title="取消本局？"
        description="取消后本局作废，所有玩家回到等待页。"
        cancelLabel="继续本局"
        confirmLabel="确认取消"
        busy={false}
        agentControlPrefix="cee.dialog"
        onConfirm={vi.fn()}
      />
    );
    expect(bodyHtml()).toMatchInlineSnapshot(`"<div></div>"`);
  });

  it("CEE：请求在途", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="放弃本局？"
        description="放弃后本局按失败结算。"
        cancelLabel="继续猜测"
        confirmLabel="确认放弃"
        busy
        agentControlPrefix="cee.dialog"
        onConfirm={vi.fn()}
      />
    );
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">放弃本局？</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">放弃后本局按失败结算。</p></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2" disabled="" data-agent-control="cee.dialog.cancel">继续猜测</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-destructive-solid text-destructive-foreground shadow-sm hover:bg-destructive-solid/90 focus-visible:outline-offset-2 h-9 px-4 py-2" disabled="" aria-busy="true" data-agent-control="cee.dialog.confirm"><span aria-hidden="true" class="inline-flex size-4 shrink-0 items-center justify-center" data-testid="button-spinner"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 size-full" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span>确认放弃</button></div></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });

  it("CEE：带来源点打开", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        origin={{ x: 120, y: 240 }}
        title="取消本局？"
        description="取消后本局作废，所有玩家回到等待页。"
        cancelLabel="继续本局"
        confirmLabel="确认取消"
        busy={false}
        agentControlPrefix="cee.dialog"
        onConfirm={vi.fn()}
      />
    );
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">取消本局？</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">取消后本局作废，所有玩家回到等待页。</p></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2" data-agent-control="cee.dialog.cancel">继续本局</button><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-destructive-solid text-destructive-foreground shadow-sm hover:bg-destructive-solid/90 focus-visible:outline-offset-2 h-9 px-4 py-2" data-agent-control="cee.dialog.confirm">确认取消</button></div></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });
});

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

describe("ConfirmDialog 的在途拦截", () => {
  it("回调返回的请求还没结束时，Esc 与取消钮都关不掉弹窗", async () => {
    const onOpenChange = vi.fn();
    let settle: (failure: string | null) => void = () => {};
    const events = userEvent.setup();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="标题"
        description="说明"
        confirmLabel="确认"
        onConfirm={() =>
          new Promise<string | null>((resolve) => {
            settle = resolve;
          })
        }
      />
    );
    await events.click(screen.getByRole("button", { name: "确认" }));
    await events.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    settle(null);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
