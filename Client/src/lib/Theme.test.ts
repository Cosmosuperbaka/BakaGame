import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { stubMatchMedia } from "@/test/MatchMedia";
import {
  initTheme,
  resolveTheme,
  setThemeId,
  setThemePreference,
  THEME_DARK_QUERY,
  THEME_ID_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "@/lib/Theme";
import { DEFAULT_THEME_ID, THEME_IDS } from "@/themes/Registry";
import { DEFAULT_THEME_MARKER, THEME_IDS_MARKER } from "../../scripts/vite-plugins/ThemeRegistry";

const stopTheme = () => {
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  delete document.documentElement.dataset.theme;
  setThemeId(DEFAULT_THEME_ID);
  window.localStorage.removeItem(THEME_ID_STORAGE_KEY);
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

  it("落盘的键名与取值固定：三档都是纯字符串，首帧脚本才读得懂", () => {
    stubMatchMedia(false);
    const stop = initTheme();
    for (const value of ["dark", "light", "system"] as const) {
      setThemePreference(value);
      expect(window.localStorage.getItem("bakagame:theme")).toBe(value);
    }
    stop();
  });

  it("主题与明暗分开落位：data-theme 恢复本地偏好，未知值回落默认主题", () => {
    stubMatchMedia(false);
    const other = THEME_IDS.find((id) => id !== DEFAULT_THEME_ID);
    window.localStorage.setItem(THEME_ID_STORAGE_KEY, other ?? DEFAULT_THEME_ID);
    let stop = initTheme();
    expect(document.documentElement.dataset.theme).toBe(other ?? DEFAULT_THEME_ID);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    stop();

    window.localStorage.setItem(THEME_ID_STORAGE_KEY, "v-unknown");
    stop = initTheme();
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
    stop();
  });

  it("切换主题只写主题键，跨标签页同步", () => {
    stubMatchMedia(true);
    const stop = initTheme();
    for (const id of THEME_IDS) {
      setThemeId(id);
      expect(document.documentElement.dataset.theme).toBe(id);
    }
    // 只有真正发生变化才落盘：只有一款主题时一次也没变过。
    expect(window.localStorage.getItem(THEME_ID_STORAGE_KEY)).toBe(
      THEME_IDS.length > 1 ? THEME_IDS.at(-1) : null
    );
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    window.localStorage.setItem(THEME_ID_STORAGE_KEY, DEFAULT_THEME_ID);
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_ID_STORAGE_KEY }));
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
    stop();
  });

  it("keeps theme restoration inline in index.html before the entry module", () => {
    const html = readIndexHtml();
    expect(html).toContain(`"${THEME_STORAGE_KEY}"`);
    expect(html).toContain(`"${THEME_ID_STORAGE_KEY}"`);
    expect(html).toContain(`"${THEME_DARK_QUERY}"`);
    expect(html).toContain('classList.toggle("dark"');
    // 主题清单由构建插件写入，HTML 里只留占位，不手抄注册表。
    expect(html).toContain(THEME_IDS_MARKER);
    expect(html).toContain(DEFAULT_THEME_MARKER);
    expect(html).toMatch(/setAttribute\(\s*"data-theme"/);
    // 首帧脚本必须是同步内联脚本，且排在入口模块之前。
    const scriptAt = html.indexOf("classList.toggle");
    const entryAt = html.indexOf('type="module"');
    expect(scriptAt).toBeGreaterThan(-1);
    expect(entryAt).toBeGreaterThan(scriptAt);
  });
});

describe("外观切换的揭示", () => {
  /** 替身：回调同步执行，每次过渡的 `finished` 交给用例手动结束，便于核对过渡期间与结束后的根元素状态。 */
  const stubViewTransition = () => {
    const finishers: Array<() => void> = [];
    const start = vi.fn((update: () => void) => {
      update();
      const finished = new Promise<void>((resolve) => {
        finishers.push(resolve);
      });
      return { finished, ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    });
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
    return { start, finishers, finish: () => finishers.forEach((resolve) => resolve()) };
  };

  afterEach(() => {
    delete (document as { startViewTransition?: unknown }).startViewTransition;
    Reflect.deleteProperty(navigator, "userActivation");
  });

  it("玩家亲手切换主题时从按下处展开，结束后清掉圆心与标记", async () => {
    stubMatchMedia(false);
    const { start, finish } = stubViewTransition();
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { isActive: true },
    });
    const stop = initTheme();
    window.dispatchEvent(new PointerEvent("pointerdown", { clientX: 40, clientY: 30 }));
    const next = THEME_IDS.find((id) => id !== DEFAULT_THEME_ID);
    if (!next) return stop();

    setThemeId(next);
    const root = document.documentElement;
    expect(start).toHaveBeenCalledOnce();
    expect(root.dataset.theme).toBe(next);
    expect(root.dataset.appearanceTransition).toBe("");
    expect(root.style.getPropertyValue("--appearance-reveal-x")).toBe("40px");
    expect(root.style.getPropertyValue("--appearance-reveal-y")).toBe("30px");

    finish();
    await vi.waitFor(() => expect(root.dataset.appearanceTransition).toBeUndefined());
    expect(root.style.getPropertyValue("--appearance-reveal-x")).toBe("");
    stop();
  });

  it("上一次揭示还没播完又切换时，旧过渡收尾不清掉新过渡的圆心与标记", async () => {
    stubMatchMedia(false);
    const { start, finishers } = stubViewTransition();
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { isActive: true },
    });
    const stop = initTheme();
    const [first, second] = THEME_IDS.filter((id) => id !== DEFAULT_THEME_ID);
    if (!first || !second) return stop();
    const root = document.documentElement;

    window.dispatchEvent(new PointerEvent("pointerdown", { clientX: 40, clientY: 30 }));
    setThemeId(first);
    window.dispatchEvent(new PointerEvent("pointerdown", { clientX: 200, clientY: 120 }));
    setThemeId(second);
    expect(start).toHaveBeenCalledTimes(2);

    // 浏览器在新过渡开始时跳过旧的那次，旧的 finished 随即结束
    finishers[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(root.dataset.appearanceTransition).toBe("");
    expect(root.style.getPropertyValue("--appearance-reveal-x")).toBe("200px");

    finishers[1]?.();
    await vi.waitFor(() => expect(root.dataset.appearanceTransition).toBeUndefined());
    expect(root.style.getPropertyValue("--appearance-reveal-x")).toBe("");
    stop();
  });

  it("偏好减弱动效、不是玩家触发或明暗看不出变化时直接落位", () => {
    const { start } = stubViewTransition();
    const root = document.documentElement;

    // 减弱动效：stubMatchMedia(true) 让所有查询都命中，包括 prefers-reduced-motion。
    stubMatchMedia(true);
    const stop = initTheme();
    setThemePreference("light");
    expect(root.classList.contains("dark")).toBe(false);
    expect(start).not.toHaveBeenCalled();
    stop();

    // 没有瞬时激活：程序或工具栏落位。
    stubMatchMedia(false);
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { isActive: false },
    });
    const stopAgain = initTheme();
    setThemePreference("dark");
    expect(root.classList.contains("dark")).toBe(true);
    expect(start).not.toHaveBeenCalled();

    // 系统是亮色、当前固定亮色时改成「跟随系统」，页面不变，不拍快照。
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { isActive: true },
    });
    setThemePreference("light");
    start.mockClear();
    setThemePreference("system");
    expect(start).not.toHaveBeenCalled();
    stopAgain();
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  });
});
