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
  void transition.finished.finally(() => {
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
  window.addEventListener("pointerdown", recordPointer, { capture: true, passive: true });

  const teardown = () => {
    media?.removeEventListener("change", onSystemChange);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("pointerdown", recordPointer, { capture: true });
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
