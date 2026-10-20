import { useSyncExternalStore } from "react";

/** 主题偏好。`system` 跟随 `prefers-color-scheme`，另两档固定。 */
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/**
 * 与 `index.html` 的首帧脚本共用同一个键：脚本在样式表与模块加载前跑，
 * 无法 import 本文件，键名改动必须两处同步（`Theme.test.ts` 会核对）。
 */
export const THEME_STORAGE_KEY = "bakagame:theme";
export const THEME_DARK_QUERY = "(prefers-color-scheme: dark)";

const listeners = new Set<() => void>();
let preference: ThemePreference = "system";
let activeTeardown: (() => void) | null = null;

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

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * 把解析结果写到 `<html>`：`.dark` 驱动全部令牌，行内 `color-scheme` 让原生控件与滚动条
 * 在样式表接手前就是对的色。`index.css` 里另有同值的 `color-scheme` 声明，作为无脚本兜底。
 */
function applyTheme(): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(preference, systemPrefersDark());
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

export function getThemePreference(): ThemePreference {
  return preference;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 读取本地偏好、立即落位，并跟随系统主题与其它标签页的切换。
 * 返回停止函数；重复调用会先停掉上一份监听，保证只有一套订阅。
 */
export function initTheme(): () => void {
  if (typeof window === "undefined") return () => {};
  activeTeardown?.();
  preference = readStoredPreference();
  applyTheme();

  const media = (() => {
    try {
      return window.matchMedia(THEME_DARK_QUERY);
    } catch {
      return null;
    }
  })();
  const onSystemChange = () => {
    if (preference !== "system") return;
    applyTheme();
    emit();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    preference = readStoredPreference();
    applyTheme();
    emit();
  };
  media?.addEventListener("change", onSystemChange);
  window.addEventListener("storage", onStorage);

  const teardown = () => {
    media?.removeEventListener("change", onSystemChange);
    window.removeEventListener("storage", onStorage);
    if (activeTeardown === teardown) activeTeardown = null;
  };
  activeTeardown = teardown;
  return teardown;
}

export function setThemePreference(next: ThemePreference): void {
  if (next === preference) return;
  preference = next;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // 隐私模式写不进去：本次会话仍然生效，只是刷新后回到默认。
  }
  applyTheme();
  emit();
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getThemePreference, () => "system");
}
