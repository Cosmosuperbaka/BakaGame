import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Toast = { text: string; type: "info" | "error" | "success" };

const probe = vi.hoisted(() => ({
  requestLogin: vi.fn(),
  initSong: vi.fn(),
  initFaker: vi.fn(),
  initCEE: vi.fn(),
  songToasts: [] as Array<Toast & { id: string }>,
  ceeToasts: [] as Array<Toast & { id: string }>,
  ceeRequestLoginAt: 0,
  fakerToasts: [] as Array<Toast & { id: string }>,
}));

// 动画在 jsdom 里会往 style 上写中间帧，逐字比对结构时先换成普通元素。
vi.mock("framer-motion", () => {
  const MOTION_ONLY = new Set([
    "layout",
    "layoutId",
    "variants",
    "initial",
    "animate",
    "exit",
    "transition",
    "custom",
  ]);
  const plain =
    (Tag: "div" | "span") =>
    ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
      const dom = Object.fromEntries(
        Object.entries(props).filter(([name]) => !MOTION_ONLY.has(name))
      );
      return <Tag {...dom}>{children}</Tag>;
    };
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: { div: plain("div"), span: plain("span") },
  };
});

vi.mock("@/components/account/AccountEntry", () => ({
  AccountDialogs: () => <div data-probe="account-dialogs" />,
  requestLogin: probe.requestLogin,
}));
vi.mock("@/components/songuessr/SongSoundBridge", () => ({
  SongSoundBridge: () => <div data-probe="song-sound-bridge" />,
}));
vi.mock("@/components/whoisfaker/FakerSoundBridge", () => ({
  FakerSoundBridge: () => <div data-probe="faker-sound-bridge" />,
}));
vi.mock("@/components/cee/CEESoundBridge", () => ({
  CEESoundBridge: () => <div data-probe="cee-sound-bridge" />,
}));
vi.mock("@/stores/UseSonGuessrStore", () => ({
  useSonGuessrStore: (select: (state: unknown) => unknown) => select({ toasts: probe.songToasts }),
  initSonGuessrWs: probe.initSong,
}));
vi.mock("@/stores/UseWhoIsFakerStore", () => ({
  useWhoIsFakerStore: (select: (state: unknown) => unknown) =>
    select({ toasts: probe.fakerToasts }),
  initWhoIsFakerWs: probe.initFaker,
}));
vi.mock("@/stores/UseCEEStore", () => ({
  useCEEStore: (select: (state: unknown) => unknown) =>
    select({ toasts: probe.ceeToasts, requestLoginAt: probe.ceeRequestLoginAt }),
  initCEEWs: probe.initCEE,
}));

import CEELayout from "./CEELayout";
import SonGuessrLayout from "./SonGuessrLayout";
import WhoIsFakerLayout from "./WhoIsFakerLayout";

const LAYOUTS = [
  ["猜歌", SonGuessrLayout, "song-sound-bridge"],
  ["谁是卧底", WhoIsFakerLayout, "faker-sound-bridge"],
  ["CEE", CEELayout, "cee-sound-bridge"],
] as const;

const renderLayout = (Layout: () => ReactNode) => {
  const router = createMemoryRouter([
    { path: "/", element: <Layout />, children: [{ index: true, element: <p>房间页</p> }] },
  ]);
  return render(<RouterProvider router={router} />);
};

const say = (text: string, type: Toast["type"]): void => {
  const item = { id: `${type}:${text}`, text, type };
  probe.songToasts = [item];
  probe.ceeToasts = [item];
  probe.fakerToasts = [item];
};

describe("游戏布局骨架", () => {
  beforeEach(() => {
    probe.songToasts = [];
    probe.ceeToasts = [];
    probe.ceeRequestLoginAt = 0;
    probe.fakerToasts = [];
  });

  it("猜歌布局的容器结构逐字不变", () => {
    say("轮到你了", "info");
    const { container } = renderLayout(SonGuessrLayout);
    expect(container.innerHTML).toMatchInlineSnapshot(
      `"<div data-probe="song-sound-bridge"></div><p>房间页</p><div role="region" aria-label="通知" class="fixed inset-x-5 top-5 z-toast ml-auto flex w-fit max-w-sm flex-col gap-2 pointer-events-none"><div role="status" aria-live="polite" class="pointer-events-auto overflow-hidden rounded-md border bg-background text-sm shadow-lg border-primary/40"><div class="flex items-start gap-2 px-4 py-3 bg-primary/10 text-primary"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info mt-0.5 size-4 shrink-0" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg><p class="min-w-0">轮到你了</p></div></div></div><div data-probe="account-dialogs"></div>"`
    );
  });

  it("谁是卧底布局的容器结构逐字不变", () => {
    say("轮到你了", "info");
    const { container } = renderLayout(WhoIsFakerLayout);
    expect(container.innerHTML).toMatchInlineSnapshot(
      `"<div data-probe="faker-sound-bridge"></div><p>房间页</p><div role="region" aria-label="通知" class="fixed inset-x-5 top-5 z-toast ml-auto flex w-fit max-w-sm flex-col gap-2 pointer-events-none"><div role="status" aria-live="polite" class="pointer-events-auto overflow-hidden rounded-md border bg-background text-sm shadow-lg border-primary/40"><div class="flex items-start gap-2 px-4 py-3 bg-primary/10 text-primary"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info mt-0.5 size-4 shrink-0" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg><p class="min-w-0">轮到你了</p></div></div></div><div data-probe="account-dialogs"></div>"`
    );
  });

  it("CEE 布局的容器结构逐字不变", () => {
    say("轮到你了", "info");
    const { container } = renderLayout(CEELayout);
    expect(container.innerHTML).toMatchInlineSnapshot(
      `"<div data-probe="cee-sound-bridge"></div><p>房间页</p><div role="region" aria-label="通知" class="fixed inset-x-5 top-5 z-toast ml-auto flex w-fit max-w-sm flex-col gap-2 pointer-events-none"><div role="status" aria-live="polite" class="pointer-events-auto overflow-hidden rounded-md border bg-background text-sm shadow-lg border-primary/40"><div class="flex items-start gap-2 px-4 py-3 bg-primary/10 text-primary"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info mt-0.5 size-4 shrink-0" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg><p class="min-w-0">轮到你了</p></div></div></div><div data-probe="account-dialogs"></div>"`
    );
  });

  it("三个布局除了各自的提示音桥之外结构完全一致", () => {
    say("密码错误", "error");
    const shapes = LAYOUTS.map(([, Layout, bridge]) => {
      const { container, unmount } = renderLayout(Layout);
      const html = container.innerHTML.replaceAll(`data-probe="${bridge}"`, "data-probe=bridge");
      unmount();
      return html;
    });
    expect(shapes[1]).toBe(shapes[0]);
    expect(shapes[2]).toBe(shapes[0]);
  });

  it("没有提示时通知区域仍然存在且为空", () => {
    const { container } = renderLayout(SonGuessrLayout);
    const region = screen.getByRole("region", { name: "通知" });
    expect(region).toBeEmptyDOMElement();
    expect(container.querySelector("[data-probe='account-dialogs']")).not.toBeNull();
  });

  it("CEE 记下登录时刻后由布局打开登录弹窗，没记下时不打开", () => {
    const first = renderLayout(CEELayout);
    expect(probe.requestLogin).not.toHaveBeenCalled();
    first.unmount();

    probe.ceeRequestLoginAt = 1_700_000_000_000;
    renderLayout(CEELayout);
    expect(probe.requestLogin).toHaveBeenCalledTimes(1);
  });

  it("各布局挂载时建自己的通道", () => {
    for (const [, Layout] of LAYOUTS) renderLayout(Layout).unmount();
    expect(probe.initSong).toHaveBeenCalledTimes(1);
    expect(probe.initFaker).toHaveBeenCalledTimes(1);
    expect(probe.initCEE).toHaveBeenCalledTimes(1);
  });
});
