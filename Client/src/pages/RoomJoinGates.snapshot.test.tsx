import type { JSX, ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "@/test/Deferred";
import { rejectedProtocol } from "@/lib/ProtocolFailure";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { useCEEStore } from "@/stores/UseCEEStore";
import WhoIsFakerRoomPage from "./WhoIsFakerRoomPage";
import SonGuessrRoomPage from "./SonGuessrRoomPage";
import CEERoomPage from "./CEERoomPage";

// 动效库在 jsdom 里会往 style 上写中间帧，逐字比对结构前把 motion.* 换成普通元素，
// 只丢掉动效专用属性，className/style/aria/data 原样保留（办法同 GameLayout.test.tsx）。
vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
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
    "onAnimationStart",
    "onAnimationComplete",
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

const { fakerWait, fakerSend, songWait, songSend } = vi.hoisted(() => ({
  fakerWait: vi.fn(),
  fakerSend: vi.fn(),
  songWait: vi.fn(),
  songSend: vi.fn(),
}));
vi.mock("@/lib/WhoIsFakerWs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/WhoIsFakerWs")>()),
  waitForConnection: fakerWait,
  send: fakerSend,
}));
vi.mock("@/lib/SonGuessrWs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/SonGuessrWs")>()),
  waitForConnection: songWait,
  send: songSend,
}));

// Radix 与 React 的 useId 令牌随组件树位置与挂载次数变化；按出现顺序换成稳定占位符，
// 既去掉抖动又保留 id 与 aria-labelledby/describedby/for 的对应关系。
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
const bodyHtml = () => normalizeIds(document.body.innerHTML);
/** 弹窗打开后 Radix 会异步给内容补上 pointer-events，等它落定再抓，免得快照随调度抖动。 */
const settledHtml = async () => {
  const dialog = screen.queryByRole("dialog");
  if (dialog) await waitFor(() => expect(dialog.style.pointerEvents).toBe("auto"));
  return bodyHtml();
};

const fakerInitial = useWhoIsFakerStore.getState();
const songInitial = useSonGuessrStore.getState();
const ceeInitial = useCEEStore.getState();

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  window.localStorage.setItem("bakagame:username", "玩家");
});
afterEach(() => {
  useWhoIsFakerStore.setState(fakerInitial, true);
  useSonGuessrStore.setState(songInitial, true);
  useCEEStore.setState(ceeInitial, true);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const renderAt = (path: string, pattern: string, element: ReactNode) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={element} />
      </Routes>
    </MemoryRouter>
  );

describe("卧底房间页进房界面逐字快照", () => {
  beforeEach(() => {
    useWhoIsFakerStore.setState({ connected: true });
  });
  const mount = () =>
    renderAt("/whoisfaker/room/1234", "/whoisfaker/room/:roomId", <WhoIsFakerRoomPage />);

  it("加载态", () => {
    fakerWait.mockReturnValue(new Promise(() => {}));
    mount();
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<div><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"><div role="status" class="flex flex-col items-center gap-3"><span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center size-8 text-primary"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 size-full" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span><span class="text-sm text-muted-foreground">正在加入房间...</span></div></div></div>"`
    );
  });
  it("名字框", async () => {
    window.localStorage.removeItem("bakagame:username");
    fakerWait.mockResolvedValue(undefined);
    mount();
    await screen.findByLabelText("用户名");
    expect(await settledHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"></div></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">设置用户名</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">进入房间 “1234” 前先取个名字，其他玩家会看到它。</p></div><form class="grid gap-4"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" aria-label="用户名" placeholder="用户名" maxlength="20" value=""><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">返回大厅</button><button type="submit" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2" disabled="">进入房间</button></div></form></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });
  it("密码框与确认后的加载态", async () => {
    fakerWait.mockResolvedValue(undefined);
    const retry = deferred<never>();
    fakerSend
      .mockImplementationOnce(() =>
        rejectedProtocol({ code: "PASSWORD_REQUIRED", message: "需要房间密码" })
      )
      .mockImplementationOnce(() => retry.promise);
    mount();
    await screen.findByLabelText("房间密码");
    expect(await settledHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"></div></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">输入房间密码</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">该链接指向一个私密房间。</p></div><form class="grid gap-4"><div class="grid gap-1.5"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" aria-label="房间密码" placeholder="请输入密码" type="password" value=""></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">返回大厅</button><button type="submit" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2" disabled="">加入房间</button></div></form></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
    fireEvent.change(screen.getByLabelText("房间密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "加入房间" }));
    await waitFor(() => expect(screen.queryByLabelText("房间密码")).toBeNull());
    expect(await settledHtml()).toMatchInlineSnapshot(
      `"<div><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"><div role="status" class="flex flex-col items-center gap-3"><span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center size-8 text-primary"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 size-full" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span><span class="text-sm text-muted-foreground">正在加入房间...</span></div></div></div>"`
    );
  });
});

describe("猜歌房间页进房界面逐字快照", () => {
  beforeEach(() => {
    useSonGuessrStore.setState({ connected: true });
  });
  const mount = (solo = false) =>
    solo
      ? renderAt("/songuessr/solo", "/songuessr/solo", <SonGuessrRoomPage solo />)
      : renderAt("/songuessr/room/1234", "/songuessr/room/:roomId", <SonGuessrRoomPage />);

  it("加载态", () => {
    songWait.mockReturnValue(new Promise(() => {}));
    mount();
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<div><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"><audio class="hidden" preload="auto" playsinline=""></audio><div role="status" class="flex flex-col items-center gap-3"><span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center size-8 text-primary"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 size-full" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span><span class="text-sm text-muted-foreground">正在加入房间...</span></div></div></div>"`
    );
  });
  it("单人模式加载态", () => {
    songWait.mockReturnValue(new Promise(() => {}));
    mount(true);
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<div><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"><audio class="hidden" preload="auto" playsinline=""></audio><div role="status" class="flex flex-col items-center gap-3"><span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center size-8 text-primary"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 size-full" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span><span class="text-sm text-muted-foreground">正在加入房间...</span></div></div></div>"`
    );
  });
  it("名字框", async () => {
    window.localStorage.removeItem("bakagame:username");
    songWait.mockResolvedValue(undefined);
    mount();
    await screen.findByLabelText("用户名");
    expect(await settledHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"><audio class="hidden" preload="auto" playsinline=""></audio></div></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">设置用户名</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">进入房间 “1234” 前先取个名字，其他玩家会看到它。</p></div><form class="grid gap-4"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" aria-label="用户名" placeholder="用户名" maxlength="20" value=""><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">返回大厅</button><button type="submit" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2" disabled="">进入房间</button></div></form></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });
  it("密码框与确认后的加载态", async () => {
    songWait.mockResolvedValue(undefined);
    const retry = deferred<never>();
    songSend
      .mockImplementationOnce(() =>
        rejectedProtocol({ code: "PASSWORD_INCORRECT", message: "房间密码错误" })
      )
      .mockImplementationOnce(() => retry.promise);
    mount();
    await screen.findByLabelText("房间密码");
    expect(await settledHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"><audio class="hidden" preload="auto" playsinline=""></audio></div></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">输入房间密码</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">该链接指向一个私密房间。</p></div><form class="grid gap-4"><div class="grid gap-1.5"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" aria-label="房间密码" placeholder="请输入密码" type="password" value=""></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">返回大厅</button><button type="submit" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2" disabled="">加入房间</button></div></form></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
    fireEvent.change(screen.getByLabelText("房间密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "加入房间" }));
    await waitFor(() => expect(screen.queryByLabelText("房间密码")).toBeNull());
    expect(await settledHtml()).toMatchInlineSnapshot(
      `"<div><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"><audio class="hidden" preload="auto" playsinline=""></audio><div role="status" class="flex flex-col items-center gap-3"><span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center size-8 text-primary"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 size-full" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span><span class="text-sm text-muted-foreground">正在加入房间...</span></div></div></div>"`
    );
  });
});

describe("CEE 房间页进房界面逐字快照", () => {
  const mount = () => renderAt("/cee/room/1234", "/cee/room/:roomId", <CEERoomPage />);
  const lockedRoom = (codes: Array<{ code: string; message: string }>) => {
    const joinRoom = vi.fn();
    for (const failure of codes) joinRoom.mockImplementationOnce(() => rejectedProtocol(failure));
    useCEEStore.setState({
      connected: true,
      lobbyReady: true,
      reconnectRoom: vi.fn().mockResolvedValue(false),
      joinRoom,
      createRoom: vi.fn(),
    });
    return joinRoom;
  };

  it("未连上时的加载态", () => {
    mount();
    expect(bodyHtml()).toMatchInlineSnapshot(
      `"<div><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"><div role="status" class="flex flex-col items-center gap-3"><span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center size-8 text-primary"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 size-full" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span><span class="text-sm text-muted-foreground">正在加入房间...</span></div></div></div>"`
    );
  });
  it("缺密码的密码框不标红", async () => {
    lockedRoom([{ code: "PASSWORD_REQUIRED", message: "需要房间密码" }]);
    mount();
    await screen.findByLabelText("房间密码");
    expect(await settledHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"></div></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">输入房间密码</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">该链接指向一个私密房间。</p></div><form class="grid gap-4"><div class="grid gap-1.5"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" aria-label="房间密码" placeholder="请输入密码" type="password" value=""></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">返回大厅</button><button type="submit" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2" disabled="">加入房间</button></div></form></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });
  it("密码错误写在框下并标红，确认在途时转回加载态", async () => {
    const joinRoom = lockedRoom([
      { code: "PASSWORD_REQUIRED", message: "需要房间密码" },
      { code: "PASSWORD_INCORRECT", message: "房间密码错误" },
    ]);
    mount();
    await screen.findByLabelText("房间密码");
    fireEvent.change(screen.getByLabelText("房间密码"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "加入房间" }));
    await screen.findByText("房间密码错误");
    expect(await settledHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"></div></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">输入房间密码</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">该链接指向一个私密房间。</p></div><form class="grid gap-4"><div class="grid gap-1.5"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" aria-label="房间密码" placeholder="请输入密码" aria-invalid="true" aria-describedby="«id3»" type="password" value="wrong"><p id="«id3»" role="alert" class="text-xs text-destructive">房间密码错误</p></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">返回大厅</button><button type="submit" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2">加入房间</button></div></form></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
    const retry = deferred<never>();
    joinRoom.mockImplementationOnce(() => retry.promise);
    fireEvent.click(screen.getByRole("button", { name: "加入房间" }));
    await waitFor(() => expect(screen.queryByLabelText("房间密码")).toBeNull());
    expect(await settledHtml()).toMatchInlineSnapshot(
      `"<div><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"><div role="status" class="flex flex-col items-center gap-3"><span aria-hidden="true" class="inline-flex shrink-0 items-center justify-center size-8 text-primary"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle lucide-loader-2 size-full" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span><span class="text-sm text-muted-foreground">正在加入房间...</span></div></div></div>"`
    );
    await act(async () => retry.reject(new DOMException("测试收尾", "AbortError")));
  });
  it("尝试过多写在框下不标红", async () => {
    lockedRoom([{ code: "TOO_MANY_ATTEMPTS", message: "尝试次数过多，请稍后再试" }]);
    mount();
    await screen.findByText("尝试次数过多，请稍后再试");
    expect(await settledHtml()).toMatchInlineSnapshot(
      `"<span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span><div data-aria-hidden="true" aria-hidden="true"><div class="flex h-full min-h-0 items-center justify-center overflow-hidden"></div></div><div class="relative z-modal"><div class="scrim fixed inset-0 z-overlay" data-state="open" style="pointer-events: auto;" data-aria-hidden="true" aria-hidden="true"></div><div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">输入房间密码</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">该链接指向一个私密房间。</p></div><form class="grid gap-4"><div class="grid gap-1.5"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" aria-label="房间密码" placeholder="请输入密码" aria-describedby="«id3»" type="password" value=""><p id="«id3»" role="alert" class="text-xs text-destructive">尝试次数过多，请稍后再试</p></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">返回大厅</button><button type="submit" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2" disabled="">加入房间</button></div></form></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div></div><span data-radix-focus-guard="" tabindex="0" style="outline: none; opacity: 0; position: fixed; pointer-events: none;" data-aria-hidden="true" aria-hidden="true"></span>"`
    );
  });
});
