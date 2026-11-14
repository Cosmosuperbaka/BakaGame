import type { JSX, ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  noPending,
  pendingOn,
  songBot,
  songSnapshot,
  waitingPlayers,
} from "@/stories/fixtures/SonGuessr";
import { ROOM_ID_TEST_MODE } from "@bakagame/shared/values";
import { SongTestController } from "./SongTestController";

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

// Radix 与 React 的 useId 令牌随组件树位置变化，重构加一层壳就会换值；
// 按出现顺序换成稳定占位符，既去掉抖动又保留 id 与 aria-* 的对应关系。
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

const testSnapshot = (bots: number) =>
  songSnapshot({
    roomId: ROOM_ID_TEST_MODE,
    testMode: true,
    players: [...waitingPlayers(), ...["A", "B"].slice(0, bots).map((suffix) => songBot(suffix))],
  });

const renderController = (bots: number, isPending = noPending) => {
  const run = vi.fn(async () => {});
  const view = render(
    <SongTestController snapshot={testSnapshot(bots)} run={run} isPending={isPending} />
  );
  return { run, html: () => normalizeIds(view.container.firstElementChild!.outerHTML) };
};

describe("SongTestController 渲染结果逐字快照", () => {
  it("展开 · 已添加人机", () => {
    expect(renderController(2).html()).toMatchInlineSnapshot(
      `"<div class="pointer-events-none absolute bottom-3 left-3 right-3 z-drawer md:bottom-5 md:left-auto md:right-5"><div class="pointer-events-auto flex justify-end"><div class="w-full max-w-full overflow-hidden floating-surface shadow-lg md:w-96"><button type="button" aria-expanded="true" class="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:-outline-offset-2"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flask-conical h-4 w-4 text-primary" aria-hidden="true"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"></path><path d="M6.453 15h11.094"></path><path d="M8.5 2h7"></path></svg><span>测试控制器</span><span aria-hidden="true" class="inline-flex ml-auto text-muted-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down h-4 w-4" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></span></button><div class=""><div class="space-y-2 border-t px-4 pb-4 pt-3"><section><h3 class="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bot h-3.5 w-3.5" aria-hidden="true"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>测试人机</h3><div class="flex items-center gap-1.5"><button type="button" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-7 rounded-md text-xs flex-1 gap-1 px-3" aria-label="移除一个测试人机"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-minus h-3 w-3" aria-hidden="true"><path d="M5 12h14"></path></svg>减一个</button><span class="w-10 text-center text-sm font-medium tabular-nums">2</span><button type="button" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-7 rounded-md text-xs flex-1 gap-1 px-3" aria-label="添加一个测试人机"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus h-3 w-3" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>加一个</button></div></section></div></div></div></div></div>"`
    );
  });

  it("展开 · 没有人机", () => {
    expect(renderController(0).html()).toMatchInlineSnapshot(
      `"<div class="pointer-events-none absolute bottom-3 left-3 right-3 z-drawer md:bottom-5 md:left-auto md:right-5"><div class="pointer-events-auto flex justify-end"><div class="w-full max-w-full overflow-hidden floating-surface shadow-lg md:w-96"><button type="button" aria-expanded="true" class="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:-outline-offset-2"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flask-conical h-4 w-4 text-primary" aria-hidden="true"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"></path><path d="M6.453 15h11.094"></path><path d="M8.5 2h7"></path></svg><span>测试控制器</span><span aria-hidden="true" class="inline-flex ml-auto text-muted-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down h-4 w-4" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></span></button><div class=""><div class="space-y-2 border-t px-4 pb-4 pt-3"><section><h3 class="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bot h-3.5 w-3.5" aria-hidden="true"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>测试人机</h3><div class="flex items-center gap-1.5"><button type="button" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-7 rounded-md text-xs flex-1 gap-1 px-3" disabled="" aria-label="移除一个测试人机"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-minus h-3 w-3" aria-hidden="true"><path d="M5 12h14"></path></svg>减一个</button><span class="w-10 text-center text-sm font-medium tabular-nums">0</span><button type="button" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-7 rounded-md text-xs flex-1 gap-1 px-3" aria-label="添加一个测试人机"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus h-3 w-3" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>加一个</button></div></section></div></div></div></div></div>"`
    );
  });

  it("展开 · 正在添加人机", () => {
    expect(renderController(2, pendingOn("song.test.addBot")).html()).toMatchInlineSnapshot(
      `"<div class="pointer-events-none absolute bottom-3 left-3 right-3 z-drawer md:bottom-5 md:left-auto md:right-5"><div class="pointer-events-auto flex justify-end"><div class="w-full max-w-full overflow-hidden floating-surface shadow-lg md:w-96"><button type="button" aria-expanded="true" class="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:-outline-offset-2"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flask-conical h-4 w-4 text-primary" aria-hidden="true"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"></path><path d="M6.453 15h11.094"></path><path d="M8.5 2h7"></path></svg><span>测试控制器</span><span aria-hidden="true" class="inline-flex ml-auto text-muted-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down h-4 w-4" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></span></button><div class=""><div class="space-y-2 border-t px-4 pb-4 pt-3"><section><h3 class="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bot h-3.5 w-3.5" aria-hidden="true"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>测试人机</h3><div class="flex items-center gap-1.5"><button type="button" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-7 rounded-md text-xs flex-1 gap-1 px-3" aria-label="移除一个测试人机"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-minus h-3 w-3" aria-hidden="true"><path d="M5 12h14"></path></svg>减一个</button><span class="w-10 text-center text-sm font-medium tabular-nums">2</span><button type="button" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-7 rounded-md text-xs flex-1 gap-1 px-3" disabled="" aria-busy="true" aria-label="添加一个测试人机"><span aria-hidden="true" class="inline-flex size-4 shrink-0 items-center justify-center" data-testid="button-spinner"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 size-full" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus h-3 w-3" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>加一个</button></div></section></div></div></div></div></div>"`
    );
  });

  it("收起", () => {
    const { html } = renderController(2);
    fireEvent.click(screen.getByRole("button", { name: /测试控制器/ }));
    expect(html()).toMatchInlineSnapshot(
      `"<div class="pointer-events-none absolute bottom-3 left-3 right-3 z-drawer md:bottom-5 md:left-auto md:right-5"><div class="pointer-events-auto flex justify-end"><div class="w-full max-w-full overflow-hidden floating-surface shadow-lg md:w-96"><button type="button" aria-expanded="false" class="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:-outline-offset-2"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flask-conical h-4 w-4 text-primary" aria-hidden="true"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"></path><path d="M6.453 15h11.094"></path><path d="M8.5 2h7"></path></svg><span>测试控制器</span><span aria-hidden="true" class="inline-flex ml-auto text-muted-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down h-4 w-4" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></span></button></div></div></div>"`
    );
  });
});

describe("SongTestController 人机行", () => {
  it("加减各发一次真实指令，没有人机时减一个禁用", () => {
    const { run } = renderController(0);
    const remove = screen.getByRole("button", { name: "移除一个测试人机" });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(run).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "添加一个测试人机" }));
    expect(run).toHaveBeenCalledWith("song.test.addBot", { count: 1 });
  });

  it("已有人机时减一个发移除指令", () => {
    const { run } = renderController(2);
    fireEvent.click(screen.getByRole("button", { name: "移除一个测试人机" }));
    expect(run).toHaveBeenCalledWith("song.test.removeBot", { count: 1 });
  });

  it("在途的那一侧禁用并转圈，另一侧照常可点", () => {
    const { run } = renderController(2, pendingOn("song.test.removeBot"));
    const remove = screen.getByRole("button", { name: "移除一个测试人机" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("aria-busy", "true");
    fireEvent.click(remove);
    expect(run).not.toHaveBeenCalled();

    const add = screen.getByRole("button", { name: "添加一个测试人机" });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(run).toHaveBeenCalledWith("song.test.addBot", { count: 1 });
  });
});
