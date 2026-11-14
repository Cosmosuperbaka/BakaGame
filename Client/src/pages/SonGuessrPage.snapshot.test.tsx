import type { JSX, ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveRoomCreateDefaults } from "@/lib/RoomSettingsMemory";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import type { SonGuessrRoomSummary } from "@bakagame/shared";
import SonGuessrPage from "./SonGuessrPage";

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

const rooms: SonGuessrRoomSummary[] = [
  {
    roomId: "8629",
    name: "绫地喰喰的房间",
    phase: "playing",
    questionType: "anime",
    playerCount: 2,
    spectatorCount: 3,
    onlineCount: 5,
    visibility: "public",
    hasPassword: true,
    allowSpectators: true,
    allowAgents: true,
  },
  {
    roomId: "1234",
    name: "日常听歌房",
    phase: "waiting",
    questionType: "song",
    playerCount: 5,
    spectatorCount: 0,
    onlineCount: 5,
    visibility: "public",
    hasPassword: false,
    allowSpectators: false,
  },
];

const initial = useSonGuessrStore.getState();

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/songuessr"]}>
      <Routes>
        <Route path="/songuessr" element={<SonGuessrPage />} />
        <Route path="/songuessr/room/:id" element={<div data-testid="room-target" />} />
      </Routes>
    </MemoryRouter>
  );

const dialogHtml = () => normalizeIds(screen.getByRole("dialog").outerHTML);

beforeEach(() => {
  window.localStorage.setItem("bakagame:username", "玩家");
  useSonGuessrStore.setState({
    rooms,
    connected: true,
    lobbyReady: true,
    reconnectRoom: vi.fn().mockResolvedValue(false),
  });
});

afterEach(() => {
  useSonGuessrStore.setState(initial, true);
  window.localStorage.clear();
});

describe("SonGuessrPage 渲染结果逐字快照", () => {
  it("大厅 · 弹窗关闭", () => {
    const { container } = renderPage();
    expect(normalizeIds(container.firstElementChild!.outerHTML)).toMatchInlineSnapshot(
      `"<div class="scrollbar-hidden flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto"><header class="border-b border-border"><div class="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 pb-4 pt-6 md:px-10 md:pt-8"><a href="/" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground rounded-md text-xs -ml-2 h-8 shrink-0 gap-1.5 px-2 text-muted-foreground"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-left h-4 w-4" aria-hidden="true"><path d="m12 19-7-7 7-7"></path><path d="M19 12H5"></path></svg><span>返回主页</span></a><div class="h-4 w-px shrink-0 bg-border"></div><h1 class="flex min-w-0 items-center gap-2 text-lg font-bold sm:text-2xl"><span class="min-w-0 truncate">Songuessr</span></h1><div class="ml-auto flex shrink-0 items-center"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-9 w-9" aria-label="设置"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings" aria-hidden="true"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"></path><circle cx="12" cy="12" r="3"></circle></svg></button></div></div></header><main class="mx-auto w-full max-w-3xl flex-1 px-6 pb-10 pt-6 md:px-10"><div class="mb-4"><div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div class="flex items-center gap-2"><h2 class="text-lg font-semibold">房间列表</h2><span class="inline-flex items-center gap-1 rounded-md border transition-colors border-border font-normal text-muted-foreground px-2.5 py-0.5 text-xs font-mono"><span class="relative inline-block tabular-nums"><span>2</span></span></span></div><div class="flex items-center gap-2.5"><input class="field-frame flex w-full rounded-md px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-8 min-w-0 flex-1 bg-card sm:w-36 sm:flex-none" placeholder="输入用户名" aria-label="用户名" maxlength="20" value="玩家"><button type="button" class="inline-flex items-center justify-center whitespace-nowrap font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:outline-offset-2 h-8 rounded-md px-3 shrink-0 gap-1.5 text-sm shadow-2xs" data-agent-control="lobby.create"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus h-3.5 w-3.5" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>创建房间</button></div></div></div><div class="grid grid-cols-1"><div class="flex flex-col gap-3 [grid-area:1/1]"><div class="rounded-md bg-card" tabindex="-1"><button type="button" data-agent-control="lobby.room.8629" tabindex="0" class="rounded-md border bg-card text-card-foreground shadow-sm block w-full cursor-pointer text-left transition-colors hover:border-primary/40 hover:bg-accent/40"><div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:px-5 sm:py-4"><div class="col-span-full row-1 flex min-w-0 items-center gap-2 truncate font-serif text-base font-medium sm:col-1"><span class="truncate">绫地喰喰的房间</span><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lock h-4 w-4 shrink-0 text-muted-foreground" aria-label="需要密码"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg><span class="inline-flex items-center gap-1 rounded-md border transition-colors border-border font-sans font-normal text-muted-foreground px-1.5 py-0.5 text-2xs leading-none shrink-0">听歌识番</span><span class="inline-flex items-center gap-1 rounded-md border transition-colors border-border font-sans font-normal text-muted-foreground px-1.5 py-0.5 text-2xs leading-none shrink-0" aria-label="支持 MCP 接入"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bot h-3 w-3" aria-hidden="true"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>MCP</span></div><div class="col-1 row-2 mt-0.5 text-sm text-muted-foreground sm:mt-1">房间号 <span class="font-mono">8629</span></div><div class="col-span-full row-3 mt-3 flex items-center gap-2 border-t border-border pt-2.5 sm:col-2 sm:row-[1/span_2] sm:mt-0 sm:border-0 sm:pt-0"><span class="inline-flex items-center gap-1 rounded-md border transition-colors border-primary/40 bg-primary/10 font-sans font-normal text-primary px-2.5 py-0.5 text-xs">游戏中</span><span class="inline-flex items-center gap-1 rounded-md border transition-colors border-border font-sans font-normal text-muted-foreground px-2.5 py-0.5 text-xs"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-eye h-3.5 w-3.5" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path><circle cx="12" cy="12" r="3"></circle></svg>可旁观</span></div><div class="col-2 row-2 mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground tabular-nums sm:col-3 sm:row-[1/span_2] sm:mt-0 sm:text-sm"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-users h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><path d="M16 3.128a4 4 0 0 1 0 7.744"></path><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><circle cx="9" cy="7" r="4"></circle></svg><span class="tabular-nums">2 人 · 3 旁观</span></div></div></button></div><div class="rounded-md bg-card" tabindex="-1"><button type="button" data-agent-control="lobby.room.1234" tabindex="0" class="rounded-md border bg-card text-card-foreground shadow-sm block w-full cursor-pointer text-left transition-colors hover:border-primary/40 hover:bg-accent/40"><div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:px-5 sm:py-4"><div class="col-span-full row-1 flex min-w-0 items-center gap-2 truncate font-serif text-base font-medium sm:col-1"><span class="truncate">日常听歌房</span></div><div class="col-1 row-2 mt-0.5 text-sm text-muted-foreground sm:mt-1">房间号 <span class="font-mono">1234</span></div><div class="col-span-full row-3 mt-3 flex items-center gap-2 border-t border-border pt-2.5 sm:col-2 sm:row-[1/span_2] sm:mt-0 sm:border-0 sm:pt-0"><span class="inline-flex items-center gap-1 rounded-md border transition-colors border-border font-sans font-normal text-muted-foreground px-2.5 py-0.5 text-xs">等待中</span><span class="inline-flex items-center gap-1 rounded-md border transition-colors border-dashed border-border font-sans font-normal text-muted-foreground opacity-60 px-2.5 py-0.5 text-xs"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-eye-off h-3.5 w-3.5" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"></path><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"></path><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"></path><path d="m2 2 20 20"></path></svg>禁止旁观</span></div><div class="col-2 row-2 mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground tabular-nums sm:col-3 sm:row-[1/span_2] sm:mt-0 sm:text-sm"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-users h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><path d="M16 3.128a4 4 0 0 1 0 7.744"></path><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><circle cx="9" cy="7" r="4"></circle></svg><span class="tabular-nums">5 人 · 0 旁观</span></div></div></button></div></div></div><section aria-labelledby="«id0»" class="mt-10 border-t border-border pt-4"><h2 id="«id0»" class="text-sm"><button type="button" aria-expanded="false" aria-controls="«id1»" class="-mx-1.5 inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 font-serif font-semibold text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground aria-expanded:text-foreground">玩法说明<span aria-hidden="true" class="inline-flex"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down h-4 w-4" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></span></button></h2><div id="«id1»" hidden="until-found"><div class="max-w-prose space-y-5 pt-3 text-sm leading-6 text-muted-foreground"><p>Songuessr 是给番剧党和歌单党准备的听歌猜歌：听一段音乐，猜歌名，或者猜这首 OP、ED 出自哪部番。歌单党比谁的耳朵更毒，番剧党比谁的前奏记得更牢。</p><div><h3 class="font-semibold text-foreground">两种题型</h3><p class="mt-1">听歌识曲要猜出歌曲本身，猜错时会看到发行年份早了还是晚了、热度高了还是低了、语种是否一致，以及和答案共有的标签。</p><p class="mt-1">听歌识番要猜出这首歌所属的番剧，番剧资料来自 Bangumi，题目可以按 OP、ED、插曲、角色歌、OST 等曲目类型筛选。</p></div><div><h3 class="font-semibold text-foreground">怎么出题</h3><p class="mt-1">手动出题时，出题人搜索网易云音乐或 QQ 音乐的歌曲并截取片段；房主也可以关掉自选片段，改由服务端随机截取。</p><p class="mt-1">自动出题时，听歌识曲按歌单、歌手和热度门槛抽题，听歌识番按年份、排行范围、歌曲热度和曲目类型抽题。</p></div><div><h3 class="font-semibold text-foreground">房间能调什么</h3><p class="mt-1">房间可以显示逐字歌词，也可以完全盲听；每回合的猜测次数、猜题时长和血战规则都由房主设定。</p></div><div><h3 class="font-semibold text-foreground">开局需要什么</h3><p class="mt-1">开局前房间里至少要有一名玩家扫码登录网易云音乐或 QQ 音乐账号，其他人只要昵称就能进房。多人房至少两名玩家，单人模式由系统自动出题。</p></div><div><h3 class="font-semibold text-foreground">适合什么场合</h3><p class="mt-1">适合歌单党互相出题，适合番剧群比谁听得出前奏，也适合一个人把补过的番再听一遍，确认自己是真的看过。</p></div><div><h3 class="font-semibold text-foreground">常见问题</h3><dl class="mt-1 space-y-3"><div><dt class="font-medium text-foreground">Songuessr 怎么玩？</dt><dd class="mt-0.5">Songuessr 是听片段猜答案的音乐竞猜游戏：每回合播放一段音乐，玩家搜索并提交歌名或番剧名。听歌识曲猜错时会看到发行年份早晚、热度高低、语种是否一致和共同标签，用来缩小范围。</dd></div><div><dt class="font-medium text-foreground">听歌识曲和听歌识番有什么区别？</dt><dd class="mt-0.5">听歌识曲要猜出这首歌本身，听歌识番要猜出这首歌所属的番剧。题型由房主在房间设置里选择，听歌识番还可以按 OP、ED、插曲、角色歌、OST 等曲目类型筛选。</dd></div><div><dt class="font-medium text-foreground">猜歌要登录音乐账号吗？</dt><dd class="mt-0.5">要，开局前房间里至少要有一名玩家扫码登录网易云音乐或 QQ 音乐账号，单人模式也一样。其他玩家只要昵称就能进房。</dd></div><div><dt class="font-medium text-foreground">可以用自己的歌单出题吗？</dt><dd class="mt-0.5">可以，自动出题时能指定一张网易云音乐或 QQ 音乐歌单，也能按歌手和热度门槛筛选。手动出题时由出题人搜歌，还可以自己截取片段。</dd></div><div><dt class="font-medium text-foreground">一个人能玩 Songuessr 吗？</dt><dd class="mt-0.5">能，单人模式由系统自动出题，不用等人。多人房至少需要两名玩家，还可以分成最多 8 支队伍。</dd></div></dl></div></div></div></section></main></div>"`
    );
  });

  it("建房弹窗 · 打开（沿用上次选项）", async () => {
    saveRoomCreateDefaults("song", { visibility: "private", allowSpectators: false });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "创建房间" }));
    await screen.findByRole("dialog");
    expect(dialogHtml()).toMatchInlineSnapshot(
      `"<div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">创建房间</h2></div><form class="grid gap-4"><div class="space-y-5"><div class="grid gap-2"><label class="text-sm peer-disabled:cursor-not-allowed peer-disabled:opacity-70 font-serif leading-snug font-normal" for="«id2»">房间名称</label><div class="flex gap-2"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" id="«id2»" maxlength="40" placeholder="输入房间名称" type="text" value="玩家的房间"></div></div><div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"><div class="min-w-0 flex-1 basis-40"><div class="flex items-center gap-2"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lock h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg><label class="text-sm peer-disabled:cursor-not-allowed peer-disabled:opacity-70 font-serif leading-snug font-normal" for="«id3»">私密房间</label></div></div><div class="ml-auto flex shrink-0 items-center"><button type="button" role="switch" aria-checked="true" data-state="checked" value="on" class="group peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input enabled:data-[state=checked]:hover:bg-primary/90 enabled:data-[state=unchecked]:hover:bg-accent" id="«id3»"><span data-state="checked" class="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm ring-0 dark:data-[state=unchecked]:bg-foreground/75 transition-transform duration-(--motion-spring-snap-duration) ease-(--motion-spring-snap) data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 group-active:scale-90"></span></button><input aria-hidden="true" tabindex="-1" style="position: absolute; pointer-events: none; opacity: 0; margin: 0px; transform: translateX(-100%); width: 0px; height: 0px;" type="checkbox" value="on" checked=""></div></div><div class=""><div class="pb-1"><div class="grid gap-2"><label class="text-sm peer-disabled:cursor-not-allowed peer-disabled:opacity-70 font-serif leading-snug font-normal" for="«id4»">房间密码</label><div class="flex gap-2"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" id="«id4»" placeholder="设置房间密码" type="password" value=""></div></div></div></div><div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"><div class="min-w-0 flex-1 basis-40"><div class="flex items-center gap-2"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-users h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><path d="M16 3.128a4 4 0 0 1 0 7.744"></path><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><circle cx="9" cy="7" r="4"></circle></svg><label class="text-sm peer-disabled:cursor-not-allowed peer-disabled:opacity-70 font-serif leading-snug font-normal" for="«id5»">允许旁观</label></div></div><div class="ml-auto flex shrink-0 items-center"><button type="button" role="switch" aria-checked="false" data-state="unchecked" value="on" class="group peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input enabled:data-[state=checked]:hover:bg-primary/90 enabled:data-[state=unchecked]:hover:bg-accent" id="«id5»"><span data-state="unchecked" class="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm ring-0 dark:data-[state=unchecked]:bg-foreground/75 transition-transform duration-(--motion-spring-snap-duration) ease-(--motion-spring-snap) data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 group-active:scale-90"></span></button><input aria-hidden="true" tabindex="-1" style="position: absolute; pointer-events: none; opacity: 0; margin: 0px; transform: translateX(-100%); width: 0px; height: 0px;" type="checkbox" value="on"></div></div></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">取消</button><button type="submit" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2">创建</button></div></form></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div>"`
    );
  });

  it("密码弹窗 · 打开", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /绫地喰喰的房间/ }));
    await screen.findByRole("dialog");
    expect(dialogHtml()).toMatchInlineSnapshot(
      `"<div style="transform-origin: 50% 50%; pointer-events: auto;" class="fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg" role="dialog" id="radix-«id0»" data-state="open" tabindex="-1" aria-labelledby="radix-«id1»" aria-describedby="radix-«id2»"><div class="scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]" style="--scroll-fade-start: 0px; --scroll-fade-end: 0px;"><div class="flex flex-col space-y-1.5 pr-8 text-left"><h2 id="radix-«id1»" class="text-lg font-semibold leading-none">输入房间密码</h2><p id="radix-«id2»" class="text-sm text-muted-foreground">房间 “绫地喰喰的房间” 需要密码</p></div><form class="grid gap-4"><div class="grid gap-1.5"><input class="field-frame flex w-full rounded-md bg-background px-3 py-1 text-sm placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-10" aria-label="房间密码" placeholder="请输入密码" type="password" value=""></div><div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">取消</button><button type="submit" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2 h-9 px-4 py-2" disabled="">加入</button></div></form></div><button type="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 cursor-pointer hover:bg-accent hover:text-accent-foreground h-8 w-8 shrink-0 text-muted-foreground absolute right-3 top-3" aria-label="关闭"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></div>"`
    );
  });
});
