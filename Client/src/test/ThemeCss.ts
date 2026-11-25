import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 主题样式表的读取与解析，供令牌完整性、对比度与注册表一致性测试共用。
 * 令牌只有一份事实来源（`src/themes/<id>.css`），测试把原文读出来复算，不把取值抄进测试。
 */

/** 按两条路径找 `src/` 下的文件：优先模块自身位置（从任意目录跑都成立），退回测试进程目录（约定为 Client 根）。 */
function resolveSrc(relative: string): string[] {
  const candidates: string[] = [];
  try {
    // 不写成 `new URL(相对路径, import.meta.url)`：Vite 会把这种写法当成资源引用改写掉。
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", relative));
  } catch {
    // transform 后 import.meta.url 不是 file: 协议，走下一条候选
  }
  candidates.push(path.resolve(process.cwd(), "src", relative));
  return candidates;
}

function readFirst(relative: string): string {
  const candidates = resolveSrc(relative);
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // 换下一条候选
    }
  }
  throw new Error(`找不到 ${relative}，已尝试：${candidates.join("、")}`);
}

export const readIndexCss = (): string => readFirst("index.css");

/** 非阻塞加载的字体样式表（中文字体与只属于某一款主题的拉丁字体）。 */
export const readFontsCss = (): string => readFirst("fonts.css");

export const readThemeCss = (id: string): string => readFirst(`themes/${id}.css`);

/** `src/themes/` 目录里实际存在的主题样式表（去掉扩展名）。 */
export function themeCssIds(): string[] {
  for (const candidate of resolveSrc("themes")) {
    try {
      return readdirSync(candidate)
        .filter((name) => name.endsWith(".css"))
        .map((name) => name.slice(0, -".css".length))
        .sort();
    } catch {
      // 换下一条候选
    }
  }
  throw new Error("找不到 src/themes 目录");
}

export interface CssRule {
  /** 逗号分隔的选择器，逐个去掉首尾空白、压缩内部空白。 */
  selectors: string[];
  /** 自定义属性与普通声明（如 `color-scheme`）一并收集，键为属性名。 */
  declarations: Record<string, string>;
}

/** 主题样式表只有平铺的规则与 `@font-face`，没有嵌套；注释先抹掉。 */
export function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorText = match[1].trim();
    const declarations: Record<string, string> = {};
    for (const declaration of match[2].split(";")) {
      const pair = declaration.match(/^\s*([\w-]+)\s*:([\s\S]*)$/);
      if (!pair) continue;
      declarations[pair[1]] = pair[2].replace(/\s+/g, " ").trim();
    }
    rules.push({
      selectors: selectorText.split(",").map((selector) => selector.trim().replace(/\s+/g, " ")),
      declarations,
    });
  }
  return rules;
}

export interface ThemeBlocks {
  light: CssRule;
  dark: CssRule;
  /** 令牌块之外的其余规则：主题样式表应当没有（Registry.test.ts 断言为空）。 */
  others: CssRule[];
}

/** 亮色块挂在 `[data-theme="id"]` 上，暗色块挂在 `.dark[data-theme="id"]` 上；各自只能有一块。 */
export function themeBlocks(id: string, css = readThemeCss(id)): ThemeBlocks {
  const rules = parseRules(css);
  const lightKey = `[data-theme="${id}"]`;
  const darkKey = `.dark[data-theme="${id}"]`;
  const lights = rules.filter((rule) => rule.selectors.includes(lightKey));
  const darks = rules.filter((rule) => rule.selectors.includes(darkKey));
  if (lights.length !== 1)
    throw new Error(`${id}.css 需要恰好一块 ${lightKey}，实际 ${lights.length} 块`);
  if (darks.length !== 1)
    throw new Error(`${id}.css 需要恰好一块 ${darkKey}，实际 ${darks.length} 块`);
  return {
    light: lights[0],
    dark: darks[0],
    others: rules.filter((rule) => rule !== lights[0] && rule !== darks[0]),
  };
}

/** 只取自定义属性（`--x`），键去掉前导 `--`。 */
export function tokensOf(rule: CssRule): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [name, value] of Object.entries(rule.declarations)) {
    if (name.startsWith("--")) tokens[name.slice(2)] = value;
  }
  return tokens;
}
