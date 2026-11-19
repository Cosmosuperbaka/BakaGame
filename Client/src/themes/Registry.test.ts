import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_THEME_MARKER,
  injectThemeRegistry,
  THEME_IDS_MARKER,
} from "../../scripts/vite-plugins/ThemeRegistry";
import { parseRules, readThemeCss, themeBlocks, themeCssIds } from "@/test/ThemeCss";
import { DEFAULT_THEME_ID, isThemeId, THEME_IDS, THEMES } from "./Registry";
import { themeLightToken } from "./ThemeSource";

/**
 * 注册表与主题样式表的一致性：新增主题只动「样式表 + 注册表一项」两处，
 * 漏掉任何一处、选择器写错导致局部预览或兜底失效，都在这里失败。
 * 令牌是否齐全、对比度是否达标见 `lib/DesignTokens.test.ts`。
 */

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

describe("主题注册表", () => {
  it("取值唯一、只用小写字母与数字，默认主题在册", () => {
    expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length);
    for (const theme of THEMES) {
      expect(theme.id).toMatch(/^[a-z0-9]+$/);
      expect(theme.label.trim()).not.toBe("");
    }
    expect(THEME_IDS).toContain(DEFAULT_THEME_ID);
    expect(isThemeId(DEFAULT_THEME_ID)).toBe(true);
    expect(isThemeId("v-unknown")).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });

  it("src/themes 下的样式表与注册表一一对应", () => {
    expect(themeCssIds()).toEqual([...THEME_IDS].sort());
  });

  for (const id of THEME_IDS) {
    it(`${id}.css 的选择器：亮色挂属性，暗色同时覆盖根元素与局部预览`, () => {
      const { light, dark, others } = themeBlocks(id);
      const isDefault = id === DEFAULT_THEME_ID;
      // 默认主题额外带零特异性兜底；其余主题不得抢兜底，否则特异性会随载入顺序打架。
      expect(light.selectors).toEqual([
        ...(isDefault ? [":where(:root)"] : []),
        `[data-theme="${id}"]`,
      ]);
      expect(dark.selectors).toEqual([
        ...(isDefault ? [":where(.dark)"] : []),
        `.dark[data-theme="${id}"]`,
        `.dark [data-theme="${id}"]`,
      ]);
      expect(light.declarations["color-scheme"]).toBe("light");
      expect(dark.declarations["color-scheme"]).toBe("dark");
      // 令牌块之外不许有任何规则：主题样式表不写组件样式，也不写 @font-face（字体只走自托管的子集与字体包）。
      expect(others).toEqual([]);
    });
  }

  it("构建脚本按选择器取亮色令牌：每款主题都取得到，且只取精确同名的令牌", () => {
    for (const id of THEME_IDS) {
      expect(themeLightToken(readThemeCss(id), id, "--background"), id).toMatch(/^oklch\(/);
    }
    // `--border` 不能误取到 `--sidebar-border`，暗色块的同名令牌也不算。
    const css = `[data-theme="x"] { --sidebar-border: red; --border: blue; } .dark[data-theme="x"] { --border: black; }`;
    expect(themeLightToken(css, "x", "--border")).toBe("blue");
    expect(themeLightToken(css, "y", "--border")).toBeUndefined();
  });

  it("只有默认主题带兜底选择器", () => {
    const fallbacks = THEME_IDS.filter((id) =>
      parseRules(readThemeCss(id)).some((rule) => rule.selectors.includes(":where(:root)"))
    );
    expect(fallbacks).toEqual([DEFAULT_THEME_ID]);
  });
});

describe("首帧脚本的主题清单", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
  });

  it("占位换成注册表取值；缺占位时构建失败", () => {
    const html = `<script>const a = ${THEME_IDS_MARKER}; const b = ${DEFAULT_THEME_MARKER};</script>`;
    expect(injectThemeRegistry(html, ["x1", "x2"], "x2")).toBe(
      '<script>const a = ["x1","x2"]; const b = "x2";</script>'
    );
    expect(() => injectThemeRegistry("<script></script>")).toThrow(THEME_IDS_MARKER);
  });

  /** 取 index.html 里写 data-theme 的那段内联脚本，注入注册表后真跑一遍。 */
  const runFirstFrameScript = () => {
    const html = injectThemeRegistry(readIndexHtml());
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1])
      .find((code) => code.includes("data-theme"));
    if (!script) throw new Error("index.html 里找不到写 data-theme 的首帧脚本");
    new Function(script)();
    return document.documentElement.getAttribute("data-theme");
  };

  it("首帧脚本恢复已存的主题，未知值与缺省回落默认主题", () => {
    expect(runFirstFrameScript()).toBe(DEFAULT_THEME_ID);
    for (const id of THEME_IDS) {
      window.localStorage.setItem("bakagame:theme-id", id);
      expect(runFirstFrameScript()).toBe(id);
    }
    window.localStorage.setItem("bakagame:theme-id", "v-unknown");
    expect(runFirstFrameScript()).toBe(DEFAULT_THEME_ID);
  });
});
