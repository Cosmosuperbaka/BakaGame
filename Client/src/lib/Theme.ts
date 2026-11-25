import { createExternalStore } from "@/lib/ExternalStore";
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from "@/themes/Registry";

/**
 * 外观有两个互相独立的维度：
 * - 明暗偏好（本文件的 `ThemePreference`）：`system` 跟随 `prefers-color-scheme`，另两档固定，落到 `<html>` 的 `.dark`；
 * - 主题（`ThemeId`，清单见 `themes/Registry.ts`）：整套语义令牌，落到 `<html data-theme>`。
 * 两者分开存、分开切换，任意组合都成立。
 */
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/**
 * 与 `index.html` 的首帧脚本共用同一组键：脚本在样式表与模块加载前跑，
 * 无法 import 本文件，键名改动必须两处同步（`Theme.test.ts` 会核对）。
 * 明暗沿用最早的键名；主题另用一个键，旧版本写下的明暗偏好不受影响。
 */
export const THEME_STORAGE_KEY = "bakagame:theme";
export const THEME_ID_STORAGE_KEY = "bakagame:theme-id";
export const THEME_DARK_QUERY = "(prefers-color-scheme: dark)";

const preference = createExternalStore<ThemePreference>("system");
const themeId = createExternalStore<ThemeId>(DEFAULT_THEME_ID);
let activeTeardown: (() => void) | null = null;

/** 最近一次指针按下的位置与时刻：玩家亲手切换明暗或主题时，新外观从这里展开。 */
let lastPointer: { x: number; y: number; at: number } | null = null;
/** 指针位置只在这段时间内算数：键盘切换、程序调用不该从很久以前点过的地方展开。 */
const POINTER_FRESH_MS = 1_000;

const recordPointer = (event: PointerEvent) => {
  lastPointer = { x: event.clientX, y: event.clientY, at: performance.now() };
};

/** 展开的圆心：刚按下的指针，否则是当前焦点元素（键盘切换）的中心，都没有就是视口中心。 */
function revealOrigin(): { x: number; y: number } {
  if (lastPointer && performance.now() - lastPointer.at < POINTER_FRESH_MS) return lastPointer;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    const rect = active.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

const prefersReducedMotion = (): boolean => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

/** 正在播放的揭示过渡：只有它的收尾才清根元素上的标记与圆心。 */
let activeReveal: ViewTransition | null = null;

/**
 * 被打断的那一次鼠标按压：按下时还停在快照上，浏览器把它判给了 `<html>`，随后的 mousedown 与 click
 * 也跟着落到 `<html>`（click 取按下与抬起两处的公共祖先），要改投给真正落点。
 */
let interruptedPress: { target: Element; releasedOn: Element | null } | null = null;

/** 改投出去的事件：它们同样经过 window 的捕获监听，要认得出来、不再处理。 */
const retargeted = new WeakSet<Event>();

/** 把截下的原事件按原样（坐标、按键、修饰键）投给真实落点；返回值同 `dispatchEvent`，被取消时为 false。 */
function redispatch(target: Element, event: MouseEvent): boolean {
  const copy =
    event instanceof PointerEvent
      ? new PointerEvent(event.type, event)
      : new MouseEvent(event.type, event);
  retargeted.add(copy);
  return target.dispatchEvent(copy);
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex], [contenteditable]:not([contenteditable="false"])';

/** 两个元素的最近公共祖先：浏览器按同一规则决定 click 落在哪。 */
function commonAncestor(a: Element, b: Element): Element {
  for (let node: Element | null = a; node; node = node.parentElement) {
    if (node.contains(b)) return node;
  }
  return document.documentElement;
}

/**
 * 揭示途中整页快照盖在最上层，浏览器把指针一律判给 `<html>`：点在设置弹窗里的按钮会被当成点在弹窗外，
 * 弹窗随即关掉，点哪儿都不生效。玩家这时按下指针，是要接着操作页面：揭示立刻走完余下的部分，
 * 这一下改投给它真正落在的元素。跳过是同步的，跳过之后的命中检测已经回到真实页面。
 * 鼠标与触控笔的 mousedown、click 随按下一起判给了 `<html>`，由下面的监听接着改投；
 * 触屏的兼容鼠标事件与 click 在抬起后才命中，跳过之后自然落到真实元素，只需改投按下本身。
 */
function interruptReveal(event: PointerEvent): void {
  // 改投出去的那一份同样会经过这里，不能让它把刚记下的按压清掉
  if (retargeted.has(event)) return;
  interruptedPress = null;
  const root = document.documentElement;
  if (!activeReveal || event.target !== root) return;
  activeReveal.skipTransition();
  const target = document.elementFromPoint(event.clientX, event.clientY);
  if (!target || target === root) return;
  event.stopImmediatePropagation();
  if (event.pointerType !== "touch") interruptedPress = { target, releasedOn: null };
  void redispatch(target, event);
}

/** 被打断那次鼠标按压的 mousedown 与 click：截下判给 `<html>` 的原事件，按原样投给真正落点。 */
function retargetInterruptedPress(event: MouseEvent): void {
  const press = interruptedPress;
  if (!press || retargeted.has(event)) return;
  if (event.type === "mouseup") {
    press.releasedOn = event.target instanceof Element ? event.target : null;
    return;
  }
  if (event.target !== document.documentElement) return;
  event.stopImmediatePropagation();
  if (event.type === "mousedown") {
    // 原事件的默认动作会把焦点从弹窗里移走：拦下它，按真实落点补上聚焦
    event.preventDefault();
    if (redispatch(press.target, event))
      press.target.closest<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
    return;
  }
  interruptedPress = null;
  const target = press.releasedOn ? commonAncestor(press.target, press.releasedOn) : press.target;
  void redispatch(target, event);
}

const PRESS_EVENTS = ["mousedown", "mouseup", "click"] as const;

const onPointerDown = (event: PointerEvent) => {
  recordPointer(event);
  interruptReveal(event);
};

/**
 * 玩家亲手换明暗或主题时，新外观从触发处按圆形铺满整页（View Transitions 的整页快照，形态见 `index.css`
 * 的「外观切换」）：旧外观定格不动，新外观从按下的那一点长出来，读作「是这一下把它换掉的」。
 * 浏览器不支持、偏好减弱动效或不是玩家亲手触发时直接落位；系统主题变化与其它标签页的同步走不到这里，同样直接落位。
 */
function swapAppearance(apply: () => void): void {
  const root = document.documentElement;
  // 只有玩家刚刚亲手操作过（瞬时激活）才算「这一下」：测试、Storybook 工具栏与程序落位没有触发者，直接换。
  const userInitiated = navigator.userActivation?.isActive ?? true;
  if (
    typeof document.startViewTransition !== "function" ||
    !userInitiated ||
    prefersReducedMotion()
  ) {
    apply();
    return;
  }
  const { x, y } = revealOrigin();
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y)
  );
  root.style.setProperty("--appearance-reveal-x", `${x}px`);
  root.style.setProperty("--appearance-reveal-y", `${y}px`);
  root.style.setProperty("--appearance-reveal-radius", `${radius}px`);
  root.dataset.appearanceTransition = "";
  const transition = document.startViewTransition(apply);
  activeReveal = transition;
  // 被跳过（连着再切一次、揭示途中被按下打断）时 ready 以 AbortError 拒绝：这是预期的收尾，不能冒成未处理的拒绝
  transition.ready.catch(() => {});
  void transition.finished.finally(() => {
    // 连点时浏览器跳过上一次过渡，它的收尾晚于新过渡开场：标记与圆心已归新过渡，旧的不能清
    if (activeReveal !== transition) return;
    activeReveal = null;
    delete root.dataset.appearanceTransition;
    for (const name of ["x", "y", "radius"])
      root.style.removeProperty(`--appearance-reveal-${name}`);
  });
}

const isPreference = (value: unknown): value is ThemePreference =>
  value === "light" || value === "dark" || value === "system";

function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/** 未知值（旧版本、手改、已下线的主题）一律回落默认主题，与首帧脚本同一口径。 */
function readStoredThemeId(): ThemeId {
  try {
    const stored = window.localStorage.getItem(THEME_ID_STORAGE_KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/** 系统当前是否暗色。环境不支持媒体查询时按亮色处理。 */
function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(THEME_DARK_QUERY).matches;
  } catch {
    return false;
  }
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

/**
 * 把解析结果写到 `<html>`：`.dark` 驱动全部令牌，行内 `color-scheme` 让原生控件与滚动条
 * 在样式表接手前就是对的色。`index.css` 里另有同值的 `color-scheme` 声明，作为无脚本兜底。
 */
function applyTheme(): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(preference.get(), systemPrefersDark());
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

/** 主题写到 `<html data-theme>`：每款主题的令牌块都挂在这个属性上，切换只换属性值。 */
function applyThemeId(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = themeId.get();
}

/**
 * 读取本地偏好、立即落位，并跟随系统主题与其它标签页的切换。
 * 返回停止函数；重复调用会先停掉上一份监听，保证只有一套订阅。
 */
export function initTheme(): () => void {
  if (typeof window === "undefined") return () => {};
  activeTeardown?.();
  preference.write(readStoredPreference());
  themeId.write(readStoredThemeId());
  applyTheme();
  applyThemeId();

  const media = (() => {
    try {
      return window.matchMedia(THEME_DARK_QUERY);
    } catch {
      return null;
    }
  })();
  const onSystemChange = () => {
    if (preference.get() !== "system") return;
    applyTheme();
    preference.emit();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) {
      preference.write(readStoredPreference());
      applyTheme();
      preference.emit();
    } else if (event.key === THEME_ID_STORAGE_KEY) {
      themeId.write(readStoredThemeId());
      applyThemeId();
      themeId.emit();
    }
  };
  media?.addEventListener("change", onSystemChange);
  window.addEventListener("storage", onStorage);
  // 捕获阶段挂在 window 上：揭示途中判给 `<html>` 的按压要赶在弹窗的「点在外面」检测之前截下
  window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  for (const type of PRESS_EVENTS)
    window.addEventListener(type, retargetInterruptedPress, { capture: true });

  const teardown = () => {
    media?.removeEventListener("change", onSystemChange);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("pointerdown", onPointerDown, { capture: true });
    for (const type of PRESS_EVENTS)
      window.removeEventListener(type, retargetInterruptedPress, { capture: true });
    if (activeTeardown === teardown) activeTeardown = null;
  };
  activeTeardown = teardown;
  return teardown;
}

export function setThemePreference(next: ThemePreference): void {
  if (next === preference.get()) return;
  // 「跟随系统」与当前明暗一致时页面不会变，不必拍快照播一段看不出变化的揭示。
  const visible =
    resolveTheme(next, systemPrefersDark()) !== resolveTheme(preference.get(), systemPrefersDark());
  preference.write(next);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // 隐私模式写不进去：本次会话仍然生效，只是刷新后回到默认。
  }
  const apply = () => {
    applyTheme();
    preference.emit();
  };
  if (visible) swapAppearance(apply);
  else apply();
}

export const useThemePreference = preference.use;

export function setThemeId(next: ThemeId): void {
  if (next === themeId.get()) return;
  themeId.write(next);
  try {
    window.localStorage.setItem(THEME_ID_STORAGE_KEY, next);
  } catch {
    // 隐私模式写不进去：本次会话仍然生效，只是刷新后回到默认主题。
  }
  swapAppearance(() => {
    applyThemeId();
    themeId.emit();
  });
}

export const useThemeId = themeId.use;
