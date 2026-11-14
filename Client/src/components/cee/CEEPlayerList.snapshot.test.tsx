import type { JSX, ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CEEPlayerList } from "./CEEPlayerList";
import { ceePlayer, ceePrivateState, ceeSnapshot } from "@/stories/fixtures/CEE";

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

const hostRoom = () =>
  ceeSnapshot({
    hostPlayerId: "me",
    players: [
      ceePlayer({ id: "me", name: "我" }, { ready: true }),
      ceePlayer({ id: "p2", name: "玩家甲" }),
      ceePlayer({ id: "obs-1", name: "旁观者" }, { membership: "spectator" }),
    ],
  });

describe("CEEPlayerList 渲染结果逐字快照", () => {
  it("房主视角：操作弹窗关闭", () => {
    render(
      <CEEPlayerList snapshot={hostRoom()} privateState={ceePrivateState({ playerId: "me" })} />
    );
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<div><div data-scroll-region="" class="scrollbar-hidden relative overflow-y-auto overflow-x-hidden h-full"><div class="flex min-w-0 flex-col px-2 py-1.5"><div class="flex items-center gap-2 px-2" style="height: 1.25rem;"><h3 class="text-2xs font-normal text-muted-foreground">玩家</h3><span class="font-sans text-2xs font-normal tabular-nums text-muted-foreground">2</span><span class="h-px flex-1 bg-border"></span></div><div class="flex flex-col gap-px"><div class="min-w-0"><div class="relative flex w-full min-w-0 items-center rounded-md py-1 pl-2.5 pr-2 text-left text-sm min-h-11 gap-2.5 bg-primary/10"><span class="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary"></span><span aria-hidden="true" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm leading-none bg-primary/10 text-primary">我</span><span class="flex min-w-0 flex-1 flex-col gap-0.5"><span class="flex min-w-0 items-center gap-1.5"><span class="min-w-0 truncate font-medium" data-state="closed">我</span><span role="img" aria-label="房主" class="inline-flex shrink-0 items-center [&amp;_svg]:size-4 text-warning" data-state="closed"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-crown" aria-hidden="true"><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"></path><path d="M5 21h14"></path></svg><span class="sr-only">房主</span></span><span role="img" aria-label="准备" class="inline-flex shrink-0 items-center [&amp;_svg]:size-4 text-success" data-state="closed"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check lucide-check-circle-2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="m16 9-5.5 5.5L8 12"></path></svg><span class="sr-only">准备</span></span></span><span class="flex min-w-0 items-center gap-1.5"><span aria-label="0 分" class="ml-auto flex shrink-0 items-baseline gap-0.5 pl-2 tabular-nums"><span class="relative inline-block tabular-nums text-base leading-none"><span>0</span></span><span class="font-sans text-2xs text-muted-foreground">分</span></span></span></span></div></div><div class="min-w-0"><button type="button" aria-label="玩家甲 操作" aria-describedby="«id0»" class="relative flex w-full min-w-0 items-center rounded-md py-1 pl-2.5 pr-2 text-left text-sm min-h-11 gap-2.5 transition-colors hover:bg-accent/40 data-[state=open]:bg-accent/40 cursor-pointer focus-visible:-outline-offset-2" aria-haspopup="dialog" aria-expanded="false" data-state="closed"><span aria-hidden="true" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm leading-none bg-muted text-muted-foreground">玩</span><span id="«id0»" class="flex min-w-0 flex-1 flex-col gap-0.5"><span class="flex min-w-0 items-center gap-1.5"><span class="min-w-0 truncate font-medium" data-state="closed">玩家甲</span><span role="img" aria-label="等待" class="inline-flex shrink-0 items-center [&amp;_svg]:size-4 text-muted-foreground" data-state="closed"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clock" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg><span class="sr-only">等待</span></span></span><span class="flex min-w-0 items-center gap-1.5"><span aria-label="0 分" class="ml-auto flex shrink-0 items-baseline gap-0.5 pl-2 tabular-nums"><span class="relative inline-block tabular-nums text-base leading-none"><span>0</span></span><span class="font-sans text-2xs text-muted-foreground">分</span></span></span></span></button></div></div><div class="flex items-center gap-2 px-2 mt-1.5" style="height: 1.25rem;"><h3 class="text-2xs font-normal text-muted-foreground">旁观</h3><span class="font-sans text-2xs font-normal tabular-nums text-muted-foreground">1</span><span class="h-px flex-1 bg-border"></span></div><div class="flex flex-col gap-px"><div class="min-w-0"><button type="button" aria-label="旁观者 操作" aria-describedby="«id1»" class="relative flex w-full min-w-0 items-center rounded-md py-1 pl-2.5 pr-2 text-left text-sm min-h-11 gap-2.5 transition-colors hover:bg-accent/40 data-[state=open]:bg-accent/40 cursor-pointer focus-visible:-outline-offset-2" aria-haspopup="dialog" aria-expanded="false" data-state="closed"><span aria-hidden="true" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm leading-none bg-muted text-muted-foreground">旁</span><span id="«id1»" class="flex min-w-0 flex-1 flex-col gap-0.5"><span class="flex min-w-0 items-center gap-1.5"><span class="min-w-0 truncate font-medium" data-state="closed">旁观者</span></span><span class="flex min-w-0 items-center gap-1.5"><span aria-label="0 分" class="ml-auto flex shrink-0 items-baseline gap-0.5 pl-2 tabular-nums"><span class="relative inline-block tabular-nums text-base leading-none"><span>0</span></span><span class="font-sans text-2xs text-muted-foreground">分</span></span></span></span></button></div></div><div class="mt-1 min-w-0"><button type="button" class="inline-flex items-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground rounded-md h-8 w-full min-w-0 justify-start gap-1.5 px-2 text-xs text-muted-foreground"><span class="flex min-w-0 items-center gap-1.5"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-eye h-3.5 w-3.5 shrink-0" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path><circle cx="12" cy="12" r="3"></circle></svg><span class="truncate">加入旁观</span></span></button></div></div></div></div>"`
    );
  });

  it("房主视角：玩家操作弹窗打开", async () => {
    const user = userEvent.setup();
    render(
      <CEEPlayerList snapshot={hostRoom()} privateState={ceePrivateState({ playerId: "me" })} />
    );
    await user.click(screen.getByRole("button", { name: "玩家甲 操作" }));
    expect(screen.getByRole("button", { name: "踢出玩家" })).toBeInTheDocument();
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;"></span><div><div data-scroll-region="" class="scrollbar-hidden relative overflow-y-auto overflow-x-hidden h-full"><div class="flex min-w-0 flex-col px-2 py-1.5"><div class="flex items-center gap-2 px-2" style="height: 1.25rem;"><h3 class="text-2xs font-normal text-muted-foreground">玩家</h3><span class="font-sans text-2xs font-normal tabular-nums text-muted-foreground">2</span><span class="h-px flex-1 bg-border"></span></div><div class="flex flex-col gap-px"><div class="min-w-0"><div class="relative flex w-full min-w-0 items-center rounded-md py-1 pl-2.5 pr-2 text-left text-sm min-h-11 gap-2.5 bg-primary/10"><span class="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary"></span><span aria-hidden="true" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm leading-none bg-primary/10 text-primary">我</span><span class="flex min-w-0 flex-1 flex-col gap-0.5"><span class="flex min-w-0 items-center gap-1.5"><span class="min-w-0 truncate font-medium" data-state="closed">我</span><span role="img" aria-label="房主" class="inline-flex shrink-0 items-center [&amp;_svg]:size-4 text-warning" data-state="closed"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-crown" aria-hidden="true"><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"></path><path d="M5 21h14"></path></svg><span class="sr-only">房主</span></span><span role="img" aria-label="准备" class="inline-flex shrink-0 items-center [&amp;_svg]:size-4 text-success" data-state="closed"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check lucide-check-circle-2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="m16 9-5.5 5.5L8 12"></path></svg><span class="sr-only">准备</span></span></span><span class="flex min-w-0 items-center gap-1.5"><span aria-label="0 分" class="ml-auto flex shrink-0 items-baseline gap-0.5 pl-2 tabular-nums"><span class="relative inline-block tabular-nums text-base leading-none"><span>0</span></span><span class="font-sans text-2xs text-muted-foreground">分</span></span></span></span></div></div><div class="min-w-0"><button type="button" aria-label="玩家甲 操作" aria-describedby="«id0»" class="relative flex w-full min-w-0 items-center rounded-md py-1 pl-2.5 pr-2 text-left text-sm min-h-11 gap-2.5 transition-colors hover:bg-accent/40 data-[state=open]:bg-accent/40 cursor-pointer focus-visible:-outline-offset-2" aria-haspopup="dialog" aria-expanded="true" data-state="open" aria-controls="radix-«id1»" data-radix-popper-side="bottom" data-radix-popper-align="end"><span aria-hidden="true" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm leading-none bg-muted text-muted-foreground">玩</span><span id="«id0»" class="flex min-w-0 flex-1 flex-col gap-0.5"><span class="flex min-w-0 items-center gap-1.5"><span class="min-w-0 truncate font-medium" data-state="closed">玩家甲</span><span role="img" aria-label="等待" class="inline-flex shrink-0 items-center [&amp;_svg]:size-4 text-muted-foreground" data-state="closed"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clock" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg><span class="sr-only">等待</span></span></span><span class="flex min-w-0 items-center gap-1.5"><span aria-label="0 分" class="ml-auto flex shrink-0 items-baseline gap-0.5 pl-2 tabular-nums"><span class="relative inline-block tabular-nums text-base leading-none"><span>0</span></span><span class="font-sans text-2xs text-muted-foreground">分</span></span></span></span></button></div></div><div class="flex items-center gap-2 px-2 mt-1.5" style="height: 1.25rem;"><h3 class="text-2xs font-normal text-muted-foreground">旁观</h3><span class="font-sans text-2xs font-normal tabular-nums text-muted-foreground">1</span><span class="h-px flex-1 bg-border"></span></div><div class="flex flex-col gap-px"><div class="min-w-0"><button type="button" aria-label="旁观者 操作" aria-describedby="«id2»" class="relative flex w-full min-w-0 items-center rounded-md py-1 pl-2.5 pr-2 text-left text-sm min-h-11 gap-2.5 transition-colors hover:bg-accent/40 data-[state=open]:bg-accent/40 cursor-pointer focus-visible:-outline-offset-2" aria-haspopup="dialog" aria-expanded="false" data-state="closed"><span aria-hidden="true" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm leading-none bg-muted text-muted-foreground">旁</span><span id="«id2»" class="flex min-w-0 flex-1 flex-col gap-0.5"><span class="flex min-w-0 items-center gap-1.5"><span class="min-w-0 truncate font-medium" data-state="closed">旁观者</span></span><span class="flex min-w-0 items-center gap-1.5"><span aria-label="0 分" class="ml-auto flex shrink-0 items-baseline gap-0.5 pl-2 tabular-nums"><span class="relative inline-block tabular-nums text-base leading-none"><span>0</span></span><span class="font-sans text-2xs text-muted-foreground">分</span></span></span></span></button></div></div><div class="mt-1 min-w-0"><button type="button" class="inline-flex items-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground rounded-md h-8 w-full min-w-0 justify-start gap-1.5 px-2 text-xs text-muted-foreground"><span class="flex min-w-0 items-center gap-1.5"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-eye h-3.5 w-3.5 shrink-0" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path><circle cx="12" cy="12" r="3"></circle></svg><span class="truncate">加入旁观</span></span></button></div></div></div></div><div data-radix-popper-content-wrapper="" style="position: fixed; left: 0px; top: 0px; transform: translate(0px, 4px); min-width: max-content; z-index: auto; --radix-popper-available-width: -24px; --radix-popper-available-height: -24px; --radix-popper-anchor-width: 0px; --radix-popper-anchor-height: 0px; --radix-popper-transform-origin: 100% 0px;"><div class="z-popover origin-(--radix-popover-content-transform-origin) overflow-hidden floating-surface shadow-md" data-side="bottom" data-align="end" data-state="open" role="dialog" id="radix-«id1»" style="--radix-popover-content-transform-origin: var(--radix-popper-transform-origin); --radix-popover-content-available-width: var(--radix-popper-available-width); --radix-popover-content-available-height: var(--radix-popper-available-height); --radix-popover-trigger-width: var(--radix-popper-anchor-width); --radix-popover-trigger-height: var(--radix-popper-anchor-height);" tabindex="-1"><div class="flex flex-col"><button type="button" class="flex w-full items-center gap-2 px-4 py-2.5 text-xs font-medium transition-colors focus-visible:-outline-offset-2 border-t first:border-t-0 disabled:pointer-events-none disabled:opacity-50 text-foreground hover:bg-accent hover:text-accent-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-arrow-out-up-right lucide-arrow-up-right-from-circle h-3.5 w-3.5" aria-hidden="true"><path d="M22 12A10 10 0 1 1 12 2"></path><path d="M22 2 12 12"></path><path d="M16 2h6v6"></path></svg>转移房主</button><button type="button" class="flex w-full items-center gap-2 px-4 py-2.5 text-xs font-medium transition-colors focus-visible:-outline-offset-2 border-t first:border-t-0 disabled:pointer-events-none disabled:opacity-50 text-destructive hover:bg-destructive-solid hover:text-destructive-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-user-x h-3.5 w-3.5" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><line x1="17" x2="22" y1="8" y2="13"></line><line x1="22" x2="17" y1="8" y2="13"></line></svg>踢出玩家</button></div></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;"></span>"`
    );
  });

  it("房主视角：待批准旁观申请", () => {
    const snapshot = ceeSnapshot({
      hostPlayerId: "me",
      bakaAntiCheat: true,
      players: [
        ceePlayer({ id: "me", name: "我" }, { ready: true }),
        ceePlayer({ id: "p2", name: "玩家甲" }),
        ceePlayer({ id: "req-1", name: "请求者" }, { membership: "pendingSpectator" }),
      ],
      spectateRequests: [{ playerId: "req-1", name: "请求者", requestedAt: 0 }],
    });
    render(
      <CEEPlayerList snapshot={snapshot} privateState={ceePrivateState({ playerId: "me" })} />
    );
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<div><div data-scroll-region="" class="scrollbar-hidden relative overflow-y-auto overflow-x-hidden h-full"><div class="flex min-w-0 flex-col px-2 py-1.5"><div class="flex items-center gap-2 px-2" style="height: 1.25rem;"><h3 class="text-2xs font-normal text-muted-foreground">玩家</h3><span class="font-sans text-2xs font-normal tabular-nums text-muted-foreground">2</span><span class="h-px flex-1 bg-border"></span></div><div class="flex flex-col gap-px"><div class="min-w-0"><div class="relative flex w-full min-w-0 items-center rounded-md py-1 pl-2.5 pr-2 text-left text-sm min-h-11 gap-2.5 bg-primary/10"><span class="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary"></span><span aria-hidden="true" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm leading-none bg-primary/10 text-primary">我</span><span class="flex min-w-0 flex-1 flex-col gap-0.5"><span class="flex min-w-0 items-center gap-1.5"><span class="min-w-0 truncate font-medium" data-state="closed">我</span><span role="img" aria-label="房主" class="inline-flex shrink-0 items-center [&amp;_svg]:size-4 text-warning" data-state="closed"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-crown" aria-hidden="true"><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"></path><path d="M5 21h14"></path></svg><span class="sr-only">房主</span></span><span role="img" aria-label="准备" class="inline-flex shrink-0 items-center [&amp;_svg]:size-4 text-success" data-state="closed"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check lucide-check-circle-2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="m16 9-5.5 5.5L8 12"></path></svg><span class="sr-only">准备</span></span></span><span class="flex min-w-0 items-center gap-1.5"><span aria-label="0 分" class="ml-auto flex shrink-0 items-baseline gap-0.5 pl-2 tabular-nums"><span class="relative inline-block tabular-nums text-base leading-none"><span>0</span></span><span class="font-sans text-2xs text-muted-foreground">分</span></span></span></span></div></div><div class="min-w-0"><button type="button" aria-label="玩家甲 操作" aria-describedby="«id0»" class="relative flex w-full min-w-0 items-center rounded-md py-1 pl-2.5 pr-2 text-left text-sm min-h-11 gap-2.5 transition-colors hover:bg-accent/40 data-[state=open]:bg-accent/40 cursor-pointer focus-visible:-outline-offset-2" aria-haspopup="dialog" aria-expanded="false" data-state="closed"><span aria-hidden="true" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm leading-none bg-muted text-muted-foreground">玩</span><span id="«id0»" class="flex min-w-0 flex-1 flex-col gap-0.5"><span class="flex min-w-0 items-center gap-1.5"><span class="min-w-0 truncate font-medium" data-state="closed">玩家甲</span><span role="img" aria-label="等待" class="inline-flex shrink-0 items-center [&amp;_svg]:size-4 text-muted-foreground" data-state="closed"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clock" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg><span class="sr-only">等待</span></span></span><span class="flex min-w-0 items-center gap-1.5"><span aria-label="0 分" class="ml-auto flex shrink-0 items-baseline gap-0.5 pl-2 tabular-nums"><span class="relative inline-block tabular-nums text-base leading-none"><span>0</span></span><span class="font-sans text-2xs text-muted-foreground">分</span></span></span></span></button></div></div><div class="flex items-center gap-2 px-2 mt-1.5" style="height: 1.25rem;"><h3 class="text-2xs font-normal text-muted-foreground">旁观</h3><span class="font-sans text-2xs font-normal tabular-nums text-muted-foreground">0</span><span class="h-px flex-1 bg-border"></span></div><div class="flex flex-col gap-px"></div><div class="mt-1 min-w-0"><button type="button" class="inline-flex items-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground rounded-md h-8 w-full min-w-0 justify-start gap-1.5 px-2 text-xs text-muted-foreground"><span class="flex min-w-0 items-center gap-1.5"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-eye h-3.5 w-3.5 shrink-0" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path><circle cx="12" cy="12" r="3"></circle></svg><span class="truncate">加入旁观</span></span></button></div><div class="flex items-center gap-2 px-2 mt-1.5" style="height: 1.25rem;"><h3 class="text-2xs font-normal text-muted-foreground">待批准旁观</h3><span class="font-sans text-2xs font-normal tabular-nums text-muted-foreground">1</span><span class="h-px flex-1 bg-border"></span></div><div class="flex flex-col gap-px"><div class="flex min-w-0 items-center justify-between gap-2 px-2 py-1"><span class="min-w-0 truncate text-sm">请求者</span><span class="flex shrink-0 items-center gap-1"><button type="button" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground rounded-md h-7 gap-1 px-2 text-xs" data-agent-control="cee.spectate.approve.req-1"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check h-3.5 w-3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>同意旁观</button><button type="button" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent rounded-md h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive" aria-label="拒绝 请求者" data-agent-control="cee.spectate.reject.req-1"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x h-3.5 w-3.5" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>拒绝</button></span></div></div></div></div></div>"`
    );
  });
});
