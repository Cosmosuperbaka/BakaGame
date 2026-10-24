import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
// `?url` 与组件里是同一个导入，用来断言 mask 引用的正是 Vite 为图标包生成的资源地址。
import alibabaIconUrl from "@lobehub/icons-static-svg/icons/alibaba.svg?url";
import anthropicIconUrl from "@lobehub/icons-static-svg/icons/anthropic.svg?url";
import claudeIconUrl from "@lobehub/icons-static-svg/icons/claude.svg?url";
import deepseekIconUrl from "@lobehub/icons-static-svg/icons/deepseek.svg?url";
import geminiIconUrl from "@lobehub/icons-static-svg/icons/gemini.svg?url";
import googleIconUrl from "@lobehub/icons-static-svg/icons/google.svg?url";
import hunyuanIconUrl from "@lobehub/icons-static-svg/icons/hunyuan.svg?url";
import lobehubIconUrl from "@lobehub/icons-static-svg/icons/lobehub.svg?url";
import openaiIconUrl from "@lobehub/icons-static-svg/icons/openai.svg?url";
import qwenIconUrl from "@lobehub/icons-static-svg/icons/qwen.svg?url";
import tencentIconUrl from "@lobehub/icons-static-svg/icons/tencent.svg?url";
import zaiIconUrl from "@lobehub/icons-static-svg/icons/zai.svg?url";
import zhipuIconUrl from "@lobehub/icons-static-svg/icons/zhipu.svg?url";
import type { CreditBrandId } from "@/lib/Credits";
import { CreditBrandMark, DependencyGlyph } from "./CreditsIcons";

/**
 * 穷举 `CreditBrandId`：`Record<CreditBrandId, true>` 少一个键就编译失败，
 * 新增品牌时测试与组件映射必须一起补齐。
 */
const ALL_BRANDS = Object.keys({
  deepseek: true,
  zhipu: true,
  openai: true,
  google: true,
  tencent: true,
  anthropic: true,
  alibaba: true,
  glm: true,
  gpt: true,
  gemini: true,
  claude: true,
  hunyuan: true,
  qwen: true,
  react: true,
  typescript: true,
  tailwindcss: true,
  radixui: true,
  framer: true,
  zustand: true,
  bun: true,
  elysia: true,
  drizzle: true,
  mysql: true,
  vite: true,
  pnpm: true,
  storybook: true,
  vitest: true,
  playwright: true,
  sentry: true,
  eslint: true,
  githubactions: true,
  neteasecloudmusic: true,
  applemusic: true,
  betterauth: true,
  fontawesome: true,
  simpleicons: true,
  reactrouter: true,
  testinglibrary: true,
  lucide: true,
  zod: true,
  socketdotio: true,
  meilisearch: true,
  jsdom: true,
  orpc: true,
  fontsource: true,
  sharp: true,
  lobehub: true,
  sonar: true,
  babel: true,
  esbuild: true,
  postcss: true,
} satisfies Record<CreditBrandId, true>) as CreditBrandId[];

/**
 * AI 厂商与模型家族：来自 `@lobehub/icons-static-svg`，经 `?url` 交给 Vite 生成资源地址。
 * gpt 复用 openai 字形、glm 复用 Z.ai 字形。
 */
const LOBEHUB_BRAND_ICONS: Readonly<Partial<Record<CreditBrandId, string>>> = {
  deepseek: deepseekIconUrl,
  zhipu: zhipuIconUrl,
  openai: openaiIconUrl,
  google: googleIconUrl,
  tencent: tencentIconUrl,
  anthropic: anthropicIconUrl,
  alibaba: alibabaIconUrl,
  glm: zaiIconUrl,
  gpt: openaiIconUrl,
  gemini: geminiIconUrl,
  claude: claudeIconUrl,
  hunyuan: hunyuanIconUrl,
  qwen: qwenIconUrl,
  lobehub: lobehubIconUrl,
};

/**
 * 自备 SVG 的品牌 → `Client/public/assets/brands/` 下的文件名。
 * 只保留 simple-icons 与 LobeHub 都没有可用字形的品牌：三个技术栈图标，
 * 以及官方 logo 只在自家仓库里发布的 jsdom / oRPC / sharp / Fontsource。
 */
const PUBLIC_MASK_ASSETS: Readonly<Partial<Record<CreditBrandId, string>>> = {
  elysia: "elysia.svg",
  playwright: "playwright.svg",
  zustand: "zustand.svg",
  jsdom: "jsdom.svg",
  orpc: "orpc.svg",
  sharp: "sharp.svg",
  fontsource: "fontsource.svg",
};

/** 自备资产的 mask 地址：`public/` 下的固定路径，不经 Vite 资源管线。 */
const PUBLIC_MASK_URLS = Object.fromEntries(
  Object.entries(PUBLIC_MASK_ASSETS).map(([brand, file]) => [brand, `/assets/brands/${file}`])
) as Readonly<Partial<Record<CreditBrandId, string>>>;

/** 全部走 CSS mask 的品牌 → 预期 `mask-image` 里的资源地址。 */
const MASK_BRANDS: Readonly<Partial<Record<CreditBrandId, string>>> = {
  ...LOBEHUB_BRAND_ICONS,
  ...PUBLIC_MASK_URLS,
};

/** 单测 cwd 是 `Client/`，自备资产按 public 目录定位。 */
const BRANDS_DIR = resolve(process.cwd(), "public", "assets", "brands");

const PUBLIC_MASK_FILES = [...new Set(Object.values(PUBLIC_MASK_ASSETS) as string[])].sort();

/** 自备资产只按 UTF-8 读一遍，测试里反复取内容。 */
function brandFile(file: string): string {
  return readFileSync(resolve(BRANDS_DIR, file), "utf8");
}

/** 渲染一个品牌，返回它实际写进 `mask-image` 的值；simple-icons 品牌没有 mask。 */
function maskImageOf(brand: CreditBrandId): string | null {
  const { container } = render(<CreditBrandMark brand={brand} />);
  const span = container.querySelector("span");
  return span === null ? null : (span as HTMLElement).style.maskImage;
}

describe("CreditBrandMark", () => {
  it("对每个 CreditBrandId 都渲染出装饰性字形，不抛错", () => {
    for (const brand of ALL_BRANDS) {
      const { container, unmount } = render(<CreditBrandMark brand={brand} />);
      const glyph = container.querySelector("svg, span[aria-hidden='true']");
      expect(glyph, brand).not.toBeNull();
      expect(glyph).toHaveAttribute("aria-hidden", "true");
      unmount();
    }
  });

  it("mask 品牌渲染成带 mask 的 span，simple-icons 品牌渲染成 svg", () => {
    for (const brand of ALL_BRANDS) {
      const { container, unmount } = render(<CreditBrandMark brand={brand} />);
      const svg = container.querySelector("svg");
      const span = container.querySelector("span");
      if (Object.hasOwn(MASK_BRANDS, brand)) {
        expect(span, `${brand} 应走 CSS mask`).not.toBeNull();
        expect(svg, `${brand} 不应再引入 simple-icons`).toBeNull();
        expect((span as HTMLElement).style.maskImage, brand).toBe(`url("${MASK_BRANDS[brand]}")`);
      } else {
        expect(svg, `${brand} 应使用 simple-icons`).not.toBeNull();
        expect(span, `${brand} 不应走 CSS mask`).toBeNull();
      }
      unmount();
    }
  });

  it("AI 品牌经 ?url 拿到的资源地址非空且指向 svg 资源", () => {
    for (const [brand, url] of Object.entries(LOBEHUB_BRAND_ICONS)) {
      expect(typeof url, brand).toBe("string");
      expect(url.length, brand).toBeGreaterThan(0);
      // 构建产物是哈希资源（…/assets/xxx.svg），小文件也可能内联成 data URL。
      expect(/\.svg/.test(url) || url.startsWith("data:") || url.includes("/assets/"), brand).toBe(
        true
      );
    }
  });

  it("mask 渲染只用字形透明度，样式齐全且颜色交给 currentColor", () => {
    const { container } = render(<CreditBrandMark brand="openai" />);
    const span = container.querySelector("span");
    expect(span).not.toBeNull();
    // 标准属性与 -webkit- 属性都是内联样式；按属性名读，兼容 jsdom 的 CSSStyleDeclaration 类型。
    const style = (span as HTMLElement).style;
    expect(style.getPropertyValue("-webkit-mask-image")).toBe(`url("${openaiIconUrl}")`);
    expect(style.getPropertyValue("mask-image")).toBe(`url("${openaiIconUrl}")`);
    expect(style.getPropertyValue("-webkit-mask-size")).toBe("contain");
    expect(style.getPropertyValue("mask-size")).toBe("contain");
    expect(style.getPropertyValue("-webkit-mask-repeat")).toBe("no-repeat");
    expect(style.getPropertyValue("mask-repeat")).toBe("no-repeat");
    expect(style.getPropertyValue("-webkit-mask-position")).toBe("center");
    expect(style.getPropertyValue("mask-position")).toBe("center");
    expect(span).toHaveClass("bg-current");
  });

  it("gpt 复用 openai 字形、glm 复用 Z.ai 字形", () => {
    expect(maskImageOf("openai")).toBe(`url("${openaiIconUrl}")`);
    expect(maskImageOf("gpt")).toBe(`url("${openaiIconUrl}")`);
    expect(maskImageOf("glm")).toBe(`url("${zaiIconUrl}")`);
  });

  it("尺寸与颜色由调用处 className 决定，默认值被 twMerge 覆盖", () => {
    const simple = render(
      <CreditBrandMark brand="react" className="size-3 text-muted-foreground" />
    );
    const svg = simple.container.querySelector("svg");
    expect(svg).toHaveClass("size-3", "text-muted-foreground");
    expect(svg).not.toHaveClass("size-4");

    const masked = render(
      <CreditBrandMark brand="playwright" className="size-6 text-muted-foreground" />
    );
    const span = masked.container.querySelector("span");
    expect(span).toHaveClass("size-6", "text-muted-foreground");
    expect(span).not.toHaveClass("size-4");
  });
});

describe("自备品牌资产", () => {
  it("每个自备路径在 Client/public 下真实存在、非空且是 svg", () => {
    for (const file of PUBLIC_MASK_FILES) {
      const path = resolve(BRANDS_DIR, file);
      const stat = statSync(path);
      expect(stat.isFile(), file).toBe(true);
      expect(stat.size, file).toBeGreaterThan(0);
      expect(brandFile(file), file).toContain("<svg");
    }
  });

  it("资产目录只保留登记过的品牌 SVG", () => {
    const files = readdirSync(BRANDS_DIR)
      .filter((file) => file.endsWith(".svg"))
      .sort();
    expect(files).toEqual(PUBLIC_MASK_FILES);
  });

  it("自备品牌引用的 mask 路径都指向已登记文件", () => {
    for (const brand of Object.keys(PUBLIC_MASK_ASSETS) as CreditBrandId[]) {
      expect(maskImageOf(brand), brand).toBe(`url("/assets/brands/${PUBLIC_MASK_ASSETS[brand]}")`);
    }
  });

  it("资产内容通过 SVG 校验：无脚本、无事件、无外链、无固定尺寸，注释注明来源与许可证", () => {
    for (const file of PUBLIC_MASK_FILES) {
      const content = brandFile(file);
      const bytes = readFileSync(resolve(BRANDS_DIR, file));
      // 内容以 <svg 开头，带 viewBox；整个文件是合法 UTF-8（读回来再编码应与原字节一致）。
      expect(content.startsWith("<svg"), file).toBe(true);
      expect(content, file).toMatch(/\bviewBox="[^"]+"/);
      expect(Buffer.from(content, "utf8").equals(bytes), `${file} 必须是合法 UTF-8`).toBe(true);
      expect(content, file).not.toContain("\uFFFD");
      // 拒绝脚本、事件处理属性、foreignObject 与外链引用。
      expect(content, file).not.toMatch(/<script/i);
      expect(content, file).not.toMatch(/<foreignObject/i);
      expect(content, file).not.toMatch(/\son[a-z]+\s*=/i);
      expect(content, file).not.toMatch(/\b(?:xlink:)?href\s*=/i);
      // 根节点不保留固定宽高，尺寸完全交给调用处。
      expect(content, file).not.toMatch(/^<svg\b[^>]*\s(?:width|height)=/);
      // 文件末尾的 HTML 注释登记来源 URL 与许可证。
      expect(content, file).toMatch(/<!-- Source: https:\/\/\S+ \| License: .+ -->/);
    }
  });
});

describe("DependencyGlyph", () => {
  it("精确包名命中品牌字形（react / zustand）", () => {
    const react = render(<DependencyGlyph packageName="react" />);
    expect(react.container.querySelector("svg")).not.toBeNull();
    expect(react.container.querySelector("svg.lucide-package")).toBeNull();

    const zustand = render(<DependencyGlyph packageName="zustand" />);
    const style = (zustand.container.querySelector("span") as HTMLElement).style;
    expect(style.maskImage).toBe('url("/assets/brands/zustand.svg")');
  });

  it("scope 前缀兜底到所属项目的品牌字形（@radix-ui/react-dialog）", () => {
    const { container } = render(<DependencyGlyph packageName="@radix-ui/react-dialog" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("svg.lucide-package")).toBeNull();
  });

  it("@playwright/test 命中自备的 Playwright 字形", () => {
    const { container } = render(<DependencyGlyph packageName="@playwright/test" />);
    const style = (container.querySelector("span") as HTMLElement).style;
    expect(style.maskImage).toBe('url("/assets/brands/playwright.svg")');
  });

  it("官方 logo 只在自家仓库的包命中自备字形（jsdom / oRPC / sharp / Fontsource）", () => {
    const cases: Array<readonly [string, CreditBrandId]> = [
      ["jsdom", "jsdom"],
      ["@orpc/client", "orpc"],
      ["@orpc/contract", "orpc"],
      ["sharp", "sharp"],
      // `@fontsource` 前缀同时覆盖 @fontsource 与 @fontsource-variable 两组字体包。
      ["@fontsource-variable/noto-serif-sc", "fontsource"],
      ["@fontsource/libre-baskerville", "fontsource"],
    ];
    for (const [packageName, brand] of cases) {
      const { container, unmount } = render(<DependencyGlyph packageName={packageName} />);
      const style = (container.querySelector("span") as HTMLElement).style;
      expect(style.maskImage, packageName).toBe(`url("${PUBLIC_MASK_URLS[brand]}")`);
      unmount();
    }
  });

  it("图标包里已有字形的包不再回退通用图标（@lobehub / sonarjs / @babel / esbuild / postcss）", () => {
    const lobehub = render(<DependencyGlyph packageName="@lobehub/icons-static-svg" />);
    expect((lobehub.container.querySelector("span") as HTMLElement).style.maskImage).toBe(
      `url("${lobehubIconUrl}")`
    );

    for (const packageName of [
      "eslint-plugin-sonarjs",
      "@babel/core",
      "@babel/runtime",
      "esbuild",
      "postcss",
    ]) {
      const { container, unmount } = render(<DependencyGlyph packageName={packageName} />);
      expect(container.querySelector("svg"), packageName).not.toBeNull();
      expect(container.querySelector("svg.lucide-package"), packageName).toBeNull();
      unmount();
    }
  });

  it("client 直接依赖里有品牌字形的包都不回退通用图标", () => {
    const brandedDirectDependencies = [
      "react",
      "react-dom",
      "typescript",
      "tailwindcss",
      "@tailwindcss/vite",
      "framer-motion",
      "lucide-react",
      "react-router-dom",
      "better-auth",
      "zod",
      "vite",
      "@vitejs/plugin-react",
      "vitest",
      "@vitest/coverage-v8",
      "storybook",
      "@storybook/react-vite",
      "eslint",
      "@eslint/js",
      "eslint-plugin-react-hooks",
      "eslint-plugin-react-refresh",
      "typescript-eslint",
      "@playwright/test",
      "@sentry/react",
      "@applemusic-like-lyrics/core",
      "@icons-pack/react-simple-icons",
      "@fortawesome/react-fontawesome",
      "@testing-library/react",
      "@radix-ui/react-dialog",
      "zustand",
      "jsdom",
      "sharp",
      "@fontsource-variable/noto-serif-sc",
      "@fontsource/libre-baskerville",
      "@orpc/client",
      "@orpc/contract",
      "@lobehub/icons-static-svg",
      "eslint-plugin-sonarjs",
      "typescript7",
    ];
    for (const packageName of brandedDirectDependencies) {
      const { container, unmount } = render(<DependencyGlyph packageName={packageName} />);
      expect(container.querySelector("svg.lucide-package"), packageName).toBeNull();
      expect(container.querySelector("svg, span[aria-hidden='true']"), packageName).not.toBeNull();
      unmount();
    }
  });

  it("没有品牌的包回退 lucide Package", () => {
    const { container } = render(<DependencyGlyph packageName="left-pad" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveClass("lucide-package");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("span")).toBeNull();
  });

  it("回退图标的尺寸同样由调用处 className 决定", () => {
    const { container } = render(<DependencyGlyph packageName="left-pad" className="size-3" />);
    expect(container.querySelector("svg")).toHaveClass("size-3");
    expect(container.querySelector("svg")).not.toHaveClass("size-4");
  });
});
