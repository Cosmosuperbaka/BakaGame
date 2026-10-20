import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { stubMatchMedia } from "@/test/MatchMedia";
import {
  initTheme,
  resolveTheme,
  setThemePreference,
  THEME_DARK_QUERY,
  THEME_STORAGE_KEY,
} from "@/lib/Theme";

const stopTheme = () => {
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
};

const readIndexHtml = (): string => {
  const candidates: string[] = [];
  try {
    candidates.push(fileURLToPath(new URL("../../index.html", import.meta.url)));
  } catch {
    // transform 后 import.meta.url 不是 file: 协议，退回测试进程目录。
  }
  candidates.push(path.resolve(process.cwd(), "index.html"));
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // 换下一条候选
    }
  }
  throw new Error(`找不到 index.html，已尝试：${candidates.join("、")}`);
};

afterEach(() => {
  stopTheme();
  vi.unstubAllGlobals();
});

describe("theme", () => {
  it("resolves fixed preferences independently of the system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("restores the stored preference and follows system changes in system mode", () => {
    const media = stubMatchMedia(false);
    const stop = initTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(media.queries).toContain(THEME_DARK_QUERY);

    media.crossBreakpoint(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");

    media.crossBreakpoint(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    stop();
    expect(media.listenerCount).toBe(0);
  });

  it("persists a fixed preference and stops following the system", () => {
    const media = stubMatchMedia(true);
    const stop = initTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    setThemePreference("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    media.crossBreakpoint(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    setThemePreference("system");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    stop();
  });

  it("applies theme changes made in another tab", () => {
    stubMatchMedia(false);
    const stop = initTheme();

    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    stop();
  });

  it("keeps theme restoration inline in index.html before the entry module", () => {
    const html = readIndexHtml();
    expect(html).toContain(`"${THEME_STORAGE_KEY}"`);
    expect(html).toContain(`"${THEME_DARK_QUERY}"`);
    expect(html).toContain('classList.toggle("dark"');
    // 首帧脚本必须是同步内联脚本，且排在入口模块之前。
    const scriptAt = html.indexOf("classList.toggle");
    const entryAt = html.indexOf('type="module"');
    expect(scriptAt).toBeGreaterThan(-1);
    expect(entryAt).toBeGreaterThan(scriptAt);
  });
});
