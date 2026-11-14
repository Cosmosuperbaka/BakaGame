import type { JSX, ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreateRoomDialog } from "./CreateRoomDialog";
import { JoinPasswordDialog } from "./lobby/JoinPasswordDialog";
import { RoomJoinGate } from "./room/RoomJoinGate";

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

describe("表单弹窗渲染结果逐字快照", () => {
  it("建房弹窗：打开", () => {
    render(
      <CreateRoomDialog open onOpenChange={vi.fn()} defaultName="测试房间" onCreate={vi.fn()} />
    );
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">创建房间</h2></div><form class="grid gap-4"><div class="space-y-5"><div class="grid gap-2"><label class="text-sm peer-disabled:cursor-not-allowed peer-disabled:opacity-70 font-serif leading-snug font-normal" for="«id2»">房间名称</label><div class="flex gap-2"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" id="«id2»" placeholder="输入房间名称" type="text" value="测试房间"></div></div><div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"><div class="min-w-0 flex-1 basis-40"><div class="flex items-center gap-2"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-globe h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path></svg><label class="text-sm peer-disabled:cursor-not-allowed peer-disabled:opacity-70 font-serif leading-snug font-normal" for="«id3»">私密房间</label></div></div><div class="ml-auto flex shrink-0 items-center"><button type="button" role="switch" aria-checked="false" data-state="unchecked" value="on" class="group peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input enabled:data-[state=checked]:hover:bg-primary/90 enabled:data-[state=unchecked]:hover:bg-accent" id="«id3»"><span data-state="unchecked" class="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm ring-0 dark:data-[state=unchecked]:bg-foreground/75 transition-transform duration-(--motion-spring-snap-duration) ease-(--motion-spring-snap) data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 group-active:scale-90"></span></button><input aria-hidden="true" tabindex="-1" style="position: absolute; pointer-events: none; opacity: 0; margin: 0px; transform: translateX(-100%); width: 0px; height: 0px;" type="checkbox" value="on"></div></div><div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"><div class="min-w-0 flex-1 basis-40"><div class="flex items-center gap-2"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-users h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><path d="M16 3.128a4 4 0 0 1 0 7.744"></path><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><circle cx="9" cy="7" r="4"></circle></svg><label class="text-sm peer-disabled:cursor-not-allowed peer-disabled:opacity-70 font-serif leading-snug font-normal" for="«id4»">允许旁观</label></div></div><div class="ml-auto flex shrink-0 items-center"><button type="button" role="switch" aria-checked="true" data-state="checked" value="on" class="group peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input enabled:data-[state=checked]:hover:bg-primary/90 enabled:data-[state=unchecked]:hover:bg-accent" id="«id4»"><span data-state="checked" class="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm ring-0 dark:data-[state=unchecked]:bg-foreground/75 transition-transform duration-(--motion-spring-snap-duration) ease-(--motion-spring-snap) data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 group-active:scale-90"></span></button><input aria-hidden="true" tabindex="-1" style="position: absolute; pointer-events: none; opacity: 0; margin: 0px; transform: translateX(-100%); width: 0px; height: 0px;" type="checkbox" value="on" checked=""></div></div></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">取消</button><button type="submit" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2">创建</button></div></form></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });

  it("建房弹窗：关闭", () => {
    render(
      <CreateRoomDialog
        open={false}
        onOpenChange={vi.fn()}
        defaultName="测试房间"
        onCreate={vi.fn()}
      />
    );
    expect(bodyHtml()).toMatchInlineSnapshot(`"<div></div>"`);
  });

  it("大厅密码弹窗：打开", () => {
    render(
      <JoinPasswordDialog
        roomName="测试房间"
        password=""
        onPasswordChange={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    );
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">输入房间密码</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">房间 “测试房间” 需要密码</p></div><form class="grid gap-4"><div class="grid gap-1.5"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" aria-label="房间密码" placeholder="请输入密码" type="password" value=""></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">取消</button><button type="submit" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2" disabled="">加入</button></div></form></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });

  it("大厅密码弹窗：关闭", () => {
    render(
      <JoinPasswordDialog
        roomName={null}
        password=""
        onPasswordChange={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    );
    expect(bodyHtml()).toMatchInlineSnapshot(`"<div></div>"`);
  });

  it("进房门：加入中（两个弹窗都关闭）", () => {
    render(
      <RoomJoinGate
        roomId="ABC123"
        needsName={false}
        needsPassword={false}
        nameDraft=""
        onNameDraftChange={vi.fn()}
        onConfirmName={vi.fn()}
        passwordDraft=""
        onPasswordDraftChange={vi.fn()}
        onConfirmPassword={vi.fn()}
        onExit={vi.fn()}
      >
        <span data-probe="seo" />
      </RoomJoinGate>
    );
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<div><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"><span data-probe="seo"></span><div role="status" class="flex flex-col items-center gap-3"><span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center size-8 text-primary"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 size-full" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span><span class="text-sm text-muted-foreground">正在加入房间...</span></div></div></div>"`
    );
  });

  it("进房门：设置用户名弹窗打开", () => {
    render(
      <RoomJoinGate
        roomId="ABC123"
        needsName
        needsPassword={false}
        nameDraft=""
        onNameDraftChange={vi.fn()}
        onConfirmName={vi.fn()}
        passwordDraft=""
        onPasswordDraftChange={vi.fn()}
        onConfirmPassword={vi.fn()}
        onExit={vi.fn()}
      >
        <span data-probe="seo" />
      </RoomJoinGate>
    );
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"><span data-probe="seo"></span></div></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">设置用户名</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">进入房间 “ABC123” 前先取个名字，其他玩家会看到它。</p></div><form class="grid gap-4"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" aria-label="用户名" placeholder="用户名" maxlength="20" value=""><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">返回大厅</button><button type="submit" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2" disabled="">进入房间</button></div></form></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });

  it("进房门：输入密码弹窗打开", () => {
    render(
      <RoomJoinGate
        roomId="ABC123"
        needsName={false}
        needsPassword
        nameDraft=""
        onNameDraftChange={vi.fn()}
        onConfirmName={vi.fn()}
        passwordDraft=""
        onPasswordDraftChange={vi.fn()}
        onConfirmPassword={vi.fn()}
        onExit={vi.fn()}
      >
        <span data-probe="seo" />
      </RoomJoinGate>
    );
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"><span data-probe="seo"></span></div></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">输入房间密码</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">该链接指向一个私密房间。</p></div><form class="grid gap-4"><div class="grid gap-1.5"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" aria-label="房间密码" placeholder="请输入密码" type="password" value=""></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">返回大厅</button><button type="submit" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2" disabled="">加入房间</button></div></form></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });
});
