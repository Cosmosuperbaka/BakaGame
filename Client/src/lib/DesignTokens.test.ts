import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 主题令牌的对比度断言。令牌只有一份事实来源（`src/index.css` 的 `:root` 与 `.dark`），
 * 这里把它读出来按 WCAG 的相对亮度公式复算，而不是把取值抄进测试：
 * 改令牌却忘了核对对比度，是这套标定最容易悄悄失效的方式。
 *
 * 口径与 `index.css` 的标定注释一致，与状态色同一档：
 * - 实底方向：`--primary` 作背景压 `--primary-foreground`；
 * - 文字方向：`--primary` 作文字压各档标定表面，以及压自身叠在标定表面上的 `/10` 浅底；
 * - 页面底（`background`）铺纸纹理会压暗表面、实测约降 4%，这一档另留余量；
 * - `accent` 与暗色 `secondary` 只作悬停与浮层高亮，主色不在这两档上标定；
 *   `secondary` 的 `/10` 浅底在标定范围外（主色与状态色在这一档都只有约 3.9 至 4.3:1）。
 *
 * 状态色（成功、提示、补充、危险、出题人）与次要文字同档标定，明暗两套都要满足：
 * 作文字压全部五档表面（悬停行里同样会出现状态文字），作文字压自身 `/10` 浅底，
 * 以及实底填充压配套 `*-foreground`。
 */

/**
 * 令牌原文按两条路径取：优先用模块自身的文件位置（从任意目录跑测试都成立），
 * 退回测试进程的当前目录（约定为 Client 根）。
 */
function readThemeCss(): string {
  const candidates: string[] = [];
  try {
    candidates.push(fileURLToPath(new URL("../index.css", import.meta.url)));
  } catch {
    // transform 后 import.meta.url 不是 file: 协议，走下一条候选
  }
  candidates.push(path.resolve(process.cwd(), "src/index.css"));
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // 换下一条候选
    }
  }
  throw new Error(`找不到 index.css，已尝试：${candidates.join("、")}`);
}

const CSS = readThemeCss();

type Oklch = readonly [l: number, c: number, h: number];

/** 取 `:root` / `.dark` 块里的自定义属性，注释与换行先抹掉。 */
function themeTokens(selector: RegExp): Record<string, string> {
  const block = CSS.match(selector)?.[1];
  if (!block) throw new Error(`index.css 里找不到 ${selector} 块`);
  const tokens: Record<string, string> = {};
  for (const declaration of block.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const match = declaration.match(/\s*(--[\w-]+):([\s\S]*)/);
    if (!match) continue;
    tokens[match[1]] = match[2].replace(/\s+/g, " ").trim();
  }
  return tokens;
}

const oklchOf = (value: string | undefined, token: string): Oklch => {
  const match = value?.match(/^oklch\(([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\)$/);
  if (!match) throw new Error(`令牌 ${token} 不是 oklch 取值：${value ?? "（缺失）"}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toLinear = (encoded: number) =>
  encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
const toEncoded = (linear: number) =>
  linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;

/** oklch → 浏览器实际渲染的 8 位 sRGB（量化后才能和肉眼看到的颜色一致）。 */
function toRgb8([l, c, h]: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894843775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076805284 * s_,
  ].map((v) => clamp01(v));
  return linear.map((v) => Math.round(clamp01(toEncoded(v)) * 255)) as [number, number, number];
}

const luminanceOfRgb8 = ([r, g, b]: readonly [number, number, number]) =>
  0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255);

const luminanceOf = (color: Oklch) => luminanceOfRgb8(toRgb8(color));

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** `bg-primary/10` 这类透明度修饰符：浏览器在 gamma 编码的 sRGB 通道上合成，浅底因此比纯色更接近表面。 */
function tinted(foreground: Oklch, background: Oklch, alpha: number) {
  const f = toRgb8(foreground);
  const b = toRgb8(background);
  return luminanceOfRgb8(
    f.map((v, i) => Math.round(alpha * v + (1 - alpha) * b[i])) as [number, number, number]
  );
}

/** 铺纸纹理压暗页面底：标定按实测余量核对，断言同样扣掉这一档。 */
const GRAIN_DERATE = 1.04;

interface ThemeSpec {
  name: string;
  selector: RegExp;
  /** 承载 `text-primary` 的标定表面。 */
  textSurfaces: readonly string[];
  /** 承载 `bg-primary/10` + `text-primary` 的标定表面。 */
  tintSurfaces: readonly string[];
}

const THEMES: readonly ThemeSpec[] = [
  {
    name: "亮色",
    selector: /:root\s*\{([^}]*)\}/,
    textSurfaces: ["background", "card", "panel", "secondary", "muted"],
    tintSurfaces: ["background", "card", "panel", "muted"],
  },
  {
    name: "暗色",
    selector: /\.dark\s*\{([^}]*)\}/,
    textSurfaces: ["background", "card", "panel", "muted"],
    tintSurfaces: ["background", "card", "panel", "muted"],
  },
] as const;

/** 铺了纸纹理的表面要按实测余量扣 4%，其余表面是纯净实底。 */
const GRAINED_SURFACES = ["background"] as const;

/** 与 primary 共用同一取值的令牌：焦点环、图表首档与侧栏主色必须跟着一起标定。 */
const PRIMARY_MIRROR_TOKENS = ["ring", "chart-1", "sidebar-primary", "sidebar-ring"] as const;

/** AA 正文档；页面底另留纸纹理余量。 */
const requiredRatio = (name: string) =>
  (GRAINED_SURFACES as readonly string[]).includes(name) ? 4.5 * GRAIN_DERATE : 4.5;

describe("index.css 主色令牌", () => {
  it("公式自检：黑白 21:1，中灰 #777 对白约 4.5:1", () => {
    expect(toRgb8([1, 0, 0])).toEqual([255, 255, 255]);
    expect(toRgb8([0, 0, 0])).toEqual([0, 0, 0]);
    expect(contrast(luminanceOf([1, 0, 0]), luminanceOf([0, 0, 0]))).toBeCloseTo(21, 1);
    // #777777 是 WCAG 常用的临界档：相对亮度约 0.184，对白约 4.48:1。
    expect(luminanceOf([0.5681, 0, 0])).toBeCloseTo(0.1835, 2);
    expect(contrast(1, luminanceOf([0.5681, 0, 0]))).toBeGreaterThan(4.4);
    expect(contrast(1, luminanceOf([0.5681, 0, 0]))).toBeLessThan(4.6);
  });

  for (const theme of THEMES) {
    describe(theme.name, () => {
      const tokens = themeTokens(theme.selector);
      const primary = oklchOf(tokens["--primary"], "--primary");
      const foreground = oklchOf(tokens["--primary-foreground"], "--primary-foreground");
      const colorOf = (name: string): Oklch => oklchOf(tokens[`--${name}`], `--${name}`);

      it("主色作背景压前景文字 ≥ 4.5:1", () => {
        expect(contrast(luminanceOf(primary), luminanceOf(foreground))).toBeGreaterThanOrEqual(4.5);
      });

      it("主色作文字压标定表面 ≥ 4.5:1（页面底另留纸纹理余量）", () => {
        for (const name of theme.textSurfaces) {
          const ratio = contrast(luminanceOf(colorOf(name)), luminanceOf(primary));
          expect(ratio, `${name} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            requiredRatio(name) - 0.0001
          );
        }
      });

      it("主色作文字压自身 `/10` 浅底 ≥ 4.5:1", () => {
        for (const name of theme.tintSurfaces) {
          const ratio = contrast(tinted(primary, colorOf(name), 0.1), luminanceOf(primary));
          expect(ratio, `${name} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            requiredRatio(name) - 0.0001
          );
        }
      });

      it("焦点环在主色停靠的表面上 ≥ 3:1（非文字对比度）", () => {
        const ring = oklchOf(tokens["--ring"], "--ring");
        for (const name of theme.textSurfaces) {
          expect(
            contrast(luminanceOf(colorOf(name)), luminanceOf(ring)),
            name
          ).toBeGreaterThanOrEqual(3);
        }
      });

      it("与主色共用取值的令牌保持同步", () => {
        for (const token of PRIMARY_MIRROR_TOKENS) {
          expect(tokens[`--${token}`], token).toBe(tokens["--primary"]);
        }
      });
    });
  }
});

/** 状态语义色：与 `index.css` 注释的同档口径一一对应，`destructive` 兼作危险、断线与淘汰。 */
const STATUS_TOKENS = ["destructive", "success", "warning", "info", "questioner"] as const;

/** 状态文字与次要文字的标定表面：比主色多出 `secondary`，悬停行与浮层高亮里也要读清。 */
const STATUS_TEXT_SURFACES = ["background", "card", "panel", "secondary", "muted"] as const;

describe("index.css 状态色与次要文字令牌", () => {
  for (const theme of THEMES) {
    describe(theme.name, () => {
      const tokens = themeTokens(theme.selector);
      const colorOf = (name: string): Oklch => oklchOf(tokens[`--${name}`], `--${name}`);

      it("次要文字压标定表面 ≥ 4.5:1（页面底另留纸纹理余量）", () => {
        const muted = colorOf("muted-foreground");
        for (const name of STATUS_TEXT_SURFACES) {
          const ratio = contrast(luminanceOf(colorOf(name)), luminanceOf(muted));
          expect(ratio, `${name} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            requiredRatio(name) - 0.0001
          );
        }
      });

      for (const token of STATUS_TOKENS) {
        it(`${token} 作文字压标定表面与自身 \`/10\` 浅底 ≥ 4.5:1，实底压前景 ≥ 4.5:1`, () => {
          const status = colorOf(token);
          for (const name of STATUS_TEXT_SURFACES) {
            const ratio = contrast(luminanceOf(colorOf(name)), luminanceOf(status));
            expect(ratio, `文字 ${name} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
              requiredRatio(name) - 0.0001
            );
          }
          for (const name of theme.tintSurfaces) {
            const ratio = contrast(tinted(status, colorOf(name), 0.1), luminanceOf(status));
            expect(ratio, `浅底 ${name} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
              requiredRatio(name) - 0.0001
            );
          }
          const solid = contrast(luminanceOf(status), luminanceOf(colorOf(`${token}-foreground`)));
          expect(solid, `实底 ${solid.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        });
      }
    });
  }
});
