import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FAMILIES as LXGW_FAMILIES } from "../../scripts/font-subset-plan.mjs";

import { readFontsCss, readIndexCss, themeBlocks, tokensOf } from "@/test/ThemeCss";
import { THEMES } from "@/themes/Registry";

/**
 * 主题令牌的完整性与对比度断言，逐款主题、亮暗两套各跑一遍。令牌只有一份事实来源
 * （`src/themes/<id>.css`），这里把它读出来按 WCAG 的相对亮度公式复算，而不是把取值抄进测试：
 * 改令牌却忘了核对对比度，是这套标定最容易悄悄失效的方式。新增主题加进注册表即自动纳入。
 *
 * 口径与默认主题样式表里的标定注释一致，与状态色同一档：
 * - 实底方向：`--primary` 作背景压 `--primary-foreground`；
 * - 文字方向：`--primary` 作文字压各档标定表面，以及压自身叠在标定表面上的 `/10` 浅底；
 * - 页面底（`background`）铺纸纹理会压暗表面、实测约降 4%，这一档另留余量（不铺纹理的主题不扣）；
 * - `accent` 与暗色 `secondary` 只作悬停与浮层高亮，主色不在这两档上标定；
 *   `secondary` 的 `/10` 浅底在标定范围外（主色与状态色在这一档都只有约 3.9 至 4.3:1）。
 *
 * 状态色（成功、提示、补充、危险、出题人）与次要文字同档标定，明暗两套都要满足：
 * 作文字压全部五档表面（悬停行里同样会出现状态文字），作文字压自身 `/10` 浅底，
 * 以及实底填充压配套 `*-foreground`。
 */

type Oklch = readonly [l: number, c: number, h: number];

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

interface ModeSpec {
  /** 明暗两档的标定表面不同：暗色的 `secondary` 只作悬停与浮层高亮，主色不在这一档上标定。 */
  mode: "light" | "dark";
  /** 承载 `text-primary` 的标定表面。 */
  textSurfaces: readonly string[];
  /** 承载 `bg-primary/10` + `text-primary` 的标定表面。 */
  tintSurfaces: readonly string[];
}

const MODES: readonly ModeSpec[] = [
  {
    mode: "light",
    textSurfaces: ["background", "card", "panel", "secondary", "muted"],
    tintSurfaces: ["background", "card", "panel", "muted"],
  },
  {
    mode: "dark",
    textSurfaces: ["background", "card", "panel", "muted"],
    tintSurfaces: ["background", "card", "panel", "muted"],
  },
] as const;

interface ThemeModeSpec extends ModeSpec {
  name: string;
  /** 键带前导 `--`，与样式表原文一致。 */
  tokens: Record<string, string>;
  /** 这一套是否在页面底铺了纹理：铺了的才扣纹理余量。 */
  grained: boolean;
}

const withDashes = (tokens: Record<string, string>) =>
  Object.fromEntries(Object.entries(tokens).map(([name, value]) => [`--${name}`, value]));

/** 每款主题 × 亮暗两套。暗色块只写随明暗变化的令牌，读不到的不回退亮色（完整性另有断言）。 */
const THEME_MODES: readonly ThemeModeSpec[] = THEMES.flatMap(({ id }) => {
  const blocks = themeBlocks(id);
  return MODES.map((spec) => {
    const tokens = withDashes(tokensOf(spec.mode === "light" ? blocks.light : blocks.dark));
    return {
      ...spec,
      name: `${id} ${spec.mode === "light" ? "亮色" : "暗色"}`,
      tokens,
      grained: (tokens["--paper-grain"] ?? "none") !== "none",
    };
  });
});

/** 铺了纸纹理的表面要按实测余量扣 4%，其余表面是纯净实底。 */
const GRAINED_SURFACES = ["background"] as const;

/** 与 primary 共用同一取值的令牌：焦点环、图表首档与侧栏主色必须跟着一起标定。 */
const PRIMARY_MIRROR_TOKENS = ["ring", "chart-1", "sidebar-primary", "sidebar-ring"] as const;

/** AA 正文档；铺纹理的页面底另留余量。 */
const requiredRatio = (theme: ThemeModeSpec, name: string) =>
  theme.grained && (GRAINED_SURFACES as readonly string[]).includes(name)
    ? 4.5 * GRAIN_DERATE
    : 4.5;

/**
 * 令牌全集按 index.css 的映射推出：`@theme inline` 里引用的每个变量（动效变量由脚本生成，除外），
 * 加上基础层直接引用的楷体栈与纸纹理。字体栈、圆角与档距、字距与行高倍率随主题不随明暗，只写在亮色块；
 * 其余（颜色、阴影、纸纹理）随明暗变化，亮暗两块都必须写全。
 */
const THEME_LEVEL_TOKENS = [
  "font-kai",
  "font-sans",
  "font-serif",
  "font-ui",
  "font-mono",
  "radius",
  "radius-step",
  "tracking-normal",
  "leading-scale",
] as const;

function mappedTokens(): string[] {
  const css = readIndexCss();
  const mapping = css.match(/@theme inline\s*\{([\s\S]*?)\n\}/)?.[1];
  if (!mapping) throw new Error("index.css 里找不到 @theme inline 块");
  const names = new Set(
    [...mapping.matchAll(/var\(--([\w-]+)/g)]
      .map((match) => match[1])
      .filter((name) => !name.startsWith("motion-"))
  );
  for (const name of ["font-kai", "paper-grain"]) {
    expect(css, `index.css 不再引用 --${name}`).toContain(`var(--${name})`);
    names.add(name);
  }
  return [...names].sort();
}

describe("主题令牌完整性", () => {
  const all = mappedTokens();
  const modeTokens = all.filter(
    (name) => !(THEME_LEVEL_TOKENS as readonly string[]).includes(name)
  );

  it("令牌全集覆盖字体、圆角与档距、字距与行高倍率", () => {
    for (const name of THEME_LEVEL_TOKENS) expect(all).toContain(name);
  });

  for (const { id } of THEMES) {
    it(`${id}：亮色块写全全部令牌，暗色块写全随明暗变化的令牌，不多写游离令牌`, () => {
      const { light, dark } = themeBlocks(id);
      const lightNames = Object.keys(tokensOf(light)).sort();
      const darkNames = Object.keys(tokensOf(dark)).sort();
      expect(lightNames).toEqual(all);
      expect(darkNames).toEqual(modeTokens);
    });

    it(`${id}：圆角、档距、字距与行高倍率的写法能进 index.css 的 calc()`, () => {
      const tokens = tokensOf(themeBlocks(id).light);
      // 圆角与档距要带单位：`calc(0 - 4px)` 是无效值，整条圆角声明会被丢掉。
      expect(tokens["radius"]).toMatch(/^\d*\.?\d+(rem|px)$/);
      expect(tokens["radius-step"]).toMatch(/^\d*\.?\d+(rem|px)$/);
      expect(tokens["tracking-normal"]).toMatch(/^-?\d*\.?\d+em$/);
      // 行高倍率是纯数字：带单位会把无单位的行高变成固定长度，子元素不再按自己的字号继承。
      expect(tokens["leading-scale"]).toMatch(/^\d*\.?\d+$/);
    });
  }
});

describe("主色令牌", () => {
  it("公式自检：黑白 21:1，中灰 #777 对白约 4.5:1", () => {
    expect(toRgb8([1, 0, 0])).toEqual([255, 255, 255]);
    expect(toRgb8([0, 0, 0])).toEqual([0, 0, 0]);
    expect(contrast(luminanceOf([1, 0, 0]), luminanceOf([0, 0, 0]))).toBeCloseTo(21, 1);
    // #777777 是 WCAG 常用的临界档：相对亮度约 0.184，对白约 4.48:1。
    expect(luminanceOf([0.5681, 0, 0])).toBeCloseTo(0.1835, 2);
    expect(contrast(1, luminanceOf([0.5681, 0, 0]))).toBeGreaterThan(4.4);
    expect(contrast(1, luminanceOf([0.5681, 0, 0]))).toBeLessThan(4.6);
  });

  for (const theme of THEME_MODES) {
    describe(theme.name, () => {
      const tokens = theme.tokens;
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
            requiredRatio(theme, name) - 0.0001
          );
        }
      });

      it("主色作文字压自身 `/10` 浅底 ≥ 4.5:1", () => {
        for (const name of theme.tintSurfaces) {
          const ratio = contrast(tinted(primary, colorOf(name), 0.1), luminanceOf(primary));
          expect(ratio, `${name} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            requiredRatio(theme, name) - 0.0001
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

/** 状态语义色：与默认主题样式表注释的同档口径一一对应，`destructive` 兼作危险、断线与淘汰。 */
const STATUS_TOKENS = ["destructive", "success", "warning", "info", "questioner"] as const;

/** 状态文字与次要文字的标定表面：比主色多出 `secondary`，悬停行与浮层高亮里也要读清。 */
const STATUS_TEXT_SURFACES = ["background", "card", "panel", "secondary", "muted"] as const;

describe("状态色与次要文字令牌", () => {
  for (const theme of THEME_MODES) {
    describe(theme.name, () => {
      const tokens = theme.tokens;
      const colorOf = (name: string): Oklch => oklchOf(tokens[`--${name}`], `--${name}`);

      it("次要文字压标定表面 ≥ 4.5:1（页面底另留纸纹理余量）", () => {
        const muted = colorOf("muted-foreground");
        for (const name of STATUS_TEXT_SURFACES) {
          const ratio = contrast(luminanceOf(colorOf(name)), luminanceOf(muted));
          expect(ratio, `${name} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
            requiredRatio(theme, name) - 0.0001
          );
        }
      });

      for (const token of STATUS_TOKENS) {
        it(`${token} 作文字压标定表面与自身 \`/10\` 浅底 ≥ 4.5:1，实底压前景 ≥ 4.5:1`, () => {
          const status = colorOf(token);
          for (const name of STATUS_TEXT_SURFACES) {
            const ratio = contrast(luminanceOf(colorOf(name)), luminanceOf(status));
            expect(ratio, `文字 ${name} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
              requiredRatio(theme, name) - 0.0001
            );
          }
          for (const name of theme.tintSurfaces) {
            const ratio = contrast(tinted(status, colorOf(name), 0.1), luminanceOf(status));
            expect(ratio, `浅底 ${name} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
              requiredRatio(theme, name) - 0.0001
            );
          }
          // 危险色的实底单取 `destructive-solid`，前景只配它；其余状态色实底即文字档本身。
          const fill = token === "destructive" ? colorOf("destructive-solid") : status;
          const solid = contrast(luminanceOf(fill), luminanceOf(colorOf(`${token}-foreground`)));
          expect(solid, `实底 ${solid.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        });
      }

      it("凹陷档 muted 比页面底、面板、卡片都暗，叠在面板上仍看得出轮廓", () => {
        const muted = luminanceOf(colorOf("muted"));
        for (const name of ["background", "panel", "card"]) {
          expect(muted, name).toBeLessThan(luminanceOf(colorOf(name)));
        }
        const onPanel = contrast(luminanceOf(colorOf("panel")), muted);
        expect(onPanel, `面板 ${onPanel.toFixed(2)}:1`).toBeGreaterThanOrEqual(1.06);
      });

      it("危险实底 destructive-solid 压前景 ≥ 4.5:1；暗色下不比主色实底更亮", () => {
        const solid = colorOf("destructive-solid");
        const ratio = contrast(luminanceOf(solid), luminanceOf(colorOf("destructive-foreground")));
        expect(ratio, `实底 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        // 「全页最亮最艳的块」只在暗色出现（文字档被抬亮后直接铺成实底）。亮色的主色可以是近黑
        // （v0），任何红都比它亮，这一条在亮色没有意义。
        if (theme.mode === "dark") {
          expect(luminanceOf(solid)).toBeLessThanOrEqual(luminanceOf(colorOf("primary")) + 0.0001);
        }
      });
    });
  }
});

/**
 * 字体栈里能出现的具名族：样式表引入的 Fontsource 字体包里声明的族名，加上构建期生成子集的霞鹜文楷。
 * 族名从包里实际的 `@font-face` 读，不抄进测试：换包或升级后族名变了，这里跟着变。
 */
function selfHostedFamilies(): Set<string> {
  const require = createRequire(path.resolve(process.cwd(), "package.json"));
  const families = new Set<string>(LXGW_FAMILIES.map((family) => family.family));
  for (const css of [readIndexCss(), readFontsCss()]) {
    for (const [, specifier] of css.matchAll(/@import\s+"(@fontsource[^"]+)"/g)) {
      const entry = specifier.endsWith(".css") ? specifier : `${specifier}/index.css`;
      const source = readFileSync(require.resolve(entry), "utf8");
      for (const [, name] of source.matchAll(/font-family:\s*'([^']+)'/g)) families.add(name);
    }
  }
  return families;
}

/** 链尾允许的通用族：只在网页字体到达前顶一下。 */
const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace"]);
/** 表情没有一种彩色格式能在各平台浏览器都画出来，交给系统；只许排在通用族之后。 */
const EMOJI_FAMILIES = new Set(["Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"]);

const FONT_TOKENS = ["font-kai", "font-sans", "font-serif", "font-ui", "font-mono"] as const;

describe("字体栈只用自托管字体", () => {
  const hosted = selfHostedFamilies();

  for (const { id } of THEMES) {
    it(`${id}：每层字体栈的具名族都随站点分发，不按本机安装的族名引用`, () => {
      const tokens = tokensOf(themeBlocks(id).light);
      for (const token of FONT_TOKENS) {
        const value = tokens[token] ?? "";
        // 引用别的字体令牌（`var(--font-kai)`）的层沿用被引用那层的栈，那一层自己会被核对。
        if (/^var\(--font-[\w-]+\)$/.test(value)) continue;
        const names = value.split(",").map((part) => part.trim().replace(/^"|"$/g, ""));
        const genericAt = names.findIndex((name) => GENERIC_FAMILIES.has(name));
        expect(genericAt, `${id} --${token} 缺少链尾通用族`).toBeGreaterThan(0);
        for (const [index, name] of names.entries()) {
          if (index < genericAt)
            expect(hosted, `${id} --${token} 引用了未自托管的「${name}」`).toContain(name);
          else if (index > genericAt)
            expect(EMOJI_FAMILIES, `${id} --${token} 通用族之后只许接表情`).toContain(name);
        }
      }
    });
  }
});
