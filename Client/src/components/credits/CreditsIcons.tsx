import { createElement, type CSSProperties, type ReactNode } from "react";
import { Package } from "lucide-react";
// AI 厂商与模型家族的官方单色字形：MIT 的纯 SVG 资产包，`?url` 交给 Vite 生成静态资源地址。
// 统一走这一个包，避免多来源混用时线条粗细与视觉重量不一致。
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
// 逐图标引入：聚合入口无法摇树，整包品牌图标会一起进产物。
import SiApplemusic from "@icons-pack/react-simple-icons/icons/SiApplemusic";
import SiBabel from "@icons-pack/react-simple-icons/icons/SiBabel";
import SiBetterauth from "@icons-pack/react-simple-icons/icons/SiBetterauth";
import SiBun from "@icons-pack/react-simple-icons/icons/SiBun";
import SiDrizzle from "@icons-pack/react-simple-icons/icons/SiDrizzle";
import SiEsbuild from "@icons-pack/react-simple-icons/icons/SiEsbuild";
import SiEslint from "@icons-pack/react-simple-icons/icons/SiEslint";
import SiFontawesome from "@icons-pack/react-simple-icons/icons/SiFontawesome";
import SiFramer from "@icons-pack/react-simple-icons/icons/SiFramer";
import SiGithubactions from "@icons-pack/react-simple-icons/icons/SiGithubactions";
import SiLucide from "@icons-pack/react-simple-icons/icons/SiLucide";
import SiMeilisearch from "@icons-pack/react-simple-icons/icons/SiMeilisearch";
import SiMysql from "@icons-pack/react-simple-icons/icons/SiMysql";
import SiPnpm from "@icons-pack/react-simple-icons/icons/SiPnpm";
import SiPostcss from "@icons-pack/react-simple-icons/icons/SiPostcss";
import SiRadixui from "@icons-pack/react-simple-icons/icons/SiRadixui";
import SiReact from "@icons-pack/react-simple-icons/icons/SiReact";
import SiReactrouter from "@icons-pack/react-simple-icons/icons/SiReactrouter";
import SiSentry from "@icons-pack/react-simple-icons/icons/SiSentry";
import SiSimpleicons from "@icons-pack/react-simple-icons/icons/SiSimpleicons";
import SiSocketdotio from "@icons-pack/react-simple-icons/icons/SiSocketdotio";
import SiSonar from "@icons-pack/react-simple-icons/icons/SiSonar";
import SiStorybook from "@icons-pack/react-simple-icons/icons/SiStorybook";
import SiTailwindcss from "@icons-pack/react-simple-icons/icons/SiTailwindcss";
import SiTestinglibrary from "@icons-pack/react-simple-icons/icons/SiTestinglibrary";
import SiTypescript from "@icons-pack/react-simple-icons/icons/SiTypescript";
import SiVite from "@icons-pack/react-simple-icons/icons/SiVite";
import SiVitest from "@icons-pack/react-simple-icons/icons/SiVitest";
import SiZod from "@icons-pack/react-simple-icons/icons/SiZod";
import type { CreditBrandId } from "@/lib/Credits";
import { cn } from "@/lib/Utils";

/**
 * 品牌图标的三个渲染来源：
 * - AI 厂商与模型家族：`@lobehub/icons-static-svg`（MIT，纯 SVG 资产包）按文件导入，
 *   `?url` 交给 Vite 生成静态资源地址；
 * - 其余 simple-icons 有官方字形的品牌：用它的逐图标 React 组件；
 * - 两个图标包都没有可用字形的 elysia / playwright / zustand：用 `public/assets/brands/`
 *   里自备的官方/第三方 SVG。
 *
 * 所有来源最终都是单色字形：simple-icons 组件默认 `color: currentColor`，
 * 两个 SVG 来源经 CSS mask 渲染成 `currentColor`，颜色只由调用处的 `text-*` 决定。
 * 尺寸统一由调用处 className 决定（默认 `size-4`，会被调用处的 `size-*` 覆盖）。
 */
type BrandIcon = typeof SiReact;

/**
 * `mask` 的 src 是可直接放进 `mask-image: url(...)` 的静态资源地址：
 * 图标包经 `?url` 生成，自备资产指向 `public/` 下的固定路径。
 */
type BrandSource =
  | { kind: "simple"; Icon: BrandIcon }
  | { kind: "mask"; src: string };

/** 自备 SVG 的公共存放目录（`Client/public` 下由 Vite 原样托管，不经过 webp 管线改写）。 */
const BRAND_ASSET_DIR = "/assets/brands";

const brandAsset = (file: string) => `${BRAND_ASSET_DIR}/${file}`;

/**
 * 「品牌键 → 字形来源」的唯一真相表。类型是 `Record<CreditBrandId, BrandSource>`，
 * 漏掉任何一个 `CreditBrandId` 都会编译失败；新增品牌时先改 `lib/Credits.ts` 的键，再补这里。
 *
 * AI 厂商与模型家族统一取 `@lobehub/icons-static-svg`：gpt 复用 openai 字形、
 * glm 复用 Z.ai 字形（模型家族与厂商共用一枚官方记号）。自备资产只在两个图标包都没有
 * 可用字形时使用，不手绘、不用错误的近似品牌：
 * - elysia：Elysia 官网多色 SVG，去掉深色底圆并把其余路径归成 currentColor 后作 mask；
 * - playwright / zustand：Iconify API 的 devicon-plain 单色图标（MIT）；
 * - jsdom / fontsource：官方 logo 是「色块 + 反白字形」，合成一条 evenodd 路径（色块留实、字形挖空）；
 * - orpc：官方 icon 的深浅两笔并成一条轮廓；
 * - sharp：官方 mono 版本原样使用，笔画自带挖空用的内部 mask。
 */
const BRAND_SOURCES = {
  // AI 厂商
  deepseek: { kind: "mask", src: deepseekIconUrl },
  zhipu: { kind: "mask", src: zhipuIconUrl },
  openai: { kind: "mask", src: openaiIconUrl },
  google: { kind: "mask", src: googleIconUrl },
  tencent: { kind: "mask", src: tencentIconUrl },
  anthropic: { kind: "mask", src: anthropicIconUrl },
  alibaba: { kind: "mask", src: alibabaIconUrl },
  // AI 模型家族
  glm: { kind: "mask", src: zaiIconUrl },
  gpt: { kind: "mask", src: openaiIconUrl },
  gemini: { kind: "mask", src: geminiIconUrl },
  claude: { kind: "mask", src: claudeIconUrl },
  hunyuan: { kind: "mask", src: hunyuanIconUrl },
  qwen: { kind: "mask", src: qwenIconUrl },
  // 技术栈
  react: { kind: "simple", Icon: SiReact },
  typescript: { kind: "simple", Icon: SiTypescript },
  tailwindcss: { kind: "simple", Icon: SiTailwindcss },
  radixui: { kind: "simple", Icon: SiRadixui },
  framer: { kind: "simple", Icon: SiFramer },
  zustand: { kind: "mask", src: brandAsset("zustand.svg") },
  bun: { kind: "simple", Icon: SiBun },
  elysia: { kind: "mask", src: brandAsset("elysia.svg") },
  drizzle: { kind: "simple", Icon: SiDrizzle },
  mysql: { kind: "simple", Icon: SiMysql },
  vite: { kind: "simple", Icon: SiVite },
  pnpm: { kind: "simple", Icon: SiPnpm },
  storybook: { kind: "simple", Icon: SiStorybook },
  vitest: { kind: "simple", Icon: SiVitest },
  playwright: { kind: "mask", src: brandAsset("playwright.svg") },
  sentry: { kind: "simple", Icon: SiSentry },
  eslint: { kind: "simple", Icon: SiEslint },
  githubactions: { kind: "simple", Icon: SiGithubactions },
  // 依赖清单里会出现的品牌
  applemusic: { kind: "simple", Icon: SiApplemusic },
  betterauth: { kind: "simple", Icon: SiBetterauth },
  fontawesome: { kind: "simple", Icon: SiFontawesome },
  simpleicons: { kind: "simple", Icon: SiSimpleicons },
  reactrouter: { kind: "simple", Icon: SiReactrouter },
  testinglibrary: { kind: "simple", Icon: SiTestinglibrary },
  lucide: { kind: "simple", Icon: SiLucide },
  zod: { kind: "simple", Icon: SiZod },
  socketdotio: { kind: "simple", Icon: SiSocketdotio },
  meilisearch: { kind: "simple", Icon: SiMeilisearch },
  jsdom: { kind: "mask", src: brandAsset("jsdom.svg") },
  orpc: { kind: "mask", src: brandAsset("orpc.svg") },
  fontsource: { kind: "mask", src: brandAsset("fontsource.svg") },
  sharp: { kind: "mask", src: brandAsset("sharp.svg") },
  lobehub: { kind: "mask", src: lobehubIconUrl },
  sonar: { kind: "simple", Icon: SiSonar },
  babel: { kind: "simple", Icon: SiBabel },
  esbuild: { kind: "simple", Icon: SiEsbuild },
  postcss: { kind: "simple", Icon: SiPostcss },
} satisfies Record<CreditBrandId, BrandSource>;

/**
 * mask 的内联样式：只取字形的透明度，颜色交给 `bg-current`。
 * `-webkit-*` 与标准属性一并声明，兼容 WebKit。
 */
function maskStyle(src: string): CSSProperties {
  const source = `url("${src}")`;
  return {
    WebkitMaskImage: source,
    maskImage: source,
    WebkitMaskSize: "contain",
    maskSize: "contain",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
  };
}

/** 按来源渲染品牌字形；装饰性图标不带可访问名，尺寸与颜色由 className 收口。 */
function renderBrand(source: BrandSource, className?: string): ReactNode {
  if (source.kind === "mask") {
    return createElement("span", {
      "aria-hidden": true,
      className: cn("size-4 shrink-0 bg-current", className),
      style: maskStyle(source.src),
    });
  }
  // 清空 simple-icons 自带的 <title>：图标旁的文案已经说明了这是什么，不重复朗读。
  return createElement(source.Icon, {
    title: "",
    className: cn("size-4 shrink-0", className),
    "aria-hidden": true,
  });
}

/** 品牌标识：装饰性图标，颜色继承 currentColor，尺寸由调用处 className 决定。 */
export function CreditBrandMark({ brand, className }: { brand: CreditBrandId; className?: string }): ReactNode {
  return renderBrand(BRAND_SOURCES[brand], className);
}

/**
 * 依赖包名 → 品牌的精确映射。只收清单里实际会出现、且有官方字形的包；
 * 拆分包（`@radix-ui/react-dialog` 等）交给下面的 scope 前缀兜底，其余回退通用包图标。
 */
const DEPENDENCY_BRANDS = new Map<string, CreditBrandId>([
  // 前端
  ["react", "react"],
  ["react-dom", "react"],
  ["typescript", "typescript"],
  ["tailwindcss", "tailwindcss"],
  ["@tailwindcss/vite", "tailwindcss"],
  ["framer-motion", "framer"],
  ["lucide-react", "lucide"],
  ["zustand", "zustand"],
  ["react-router-dom", "reactrouter"],
  ["better-auth", "betterauth"],
  ["zod", "zod"],
  // 脚手架与开发辅助
  ["vite", "vite"],
  ["@vitejs/plugin-react", "vite"],
  ["vitest", "vitest"],
  ["@vitest/coverage-v8", "vitest"],
  ["storybook", "storybook"],
  ["@storybook/react-vite", "storybook"],
  ["eslint", "eslint"],
  ["@eslint/js", "eslint"],
  ["typescript-eslint", "eslint"],
  ["eslint-plugin-react-hooks", "eslint"],
  ["eslint-plugin-react-refresh", "eslint"],
  ["@playwright/test", "playwright"],
  ["playwright", "playwright"],
  // 依赖清单里会出现的品牌
  ["@sentry/react", "sentry"],
  ["@applemusic-like-lyrics/core", "applemusic"],
  ["@icons-pack/react-simple-icons", "simpleicons"],
  ["@fortawesome/react-fontawesome", "fontawesome"],
  ["@fortawesome/fontawesome-svg-core", "fontawesome"],
  ["@fortawesome/free-brands-svg-icons", "fontawesome"],
  ["@testing-library/react", "testinglibrary"],
  ["@testing-library/user-event", "testinglibrary"],
  ["@testing-library/jest-dom", "testinglibrary"],
  // 服务端与工具链
  ["elysia", "elysia"],
  ["drizzle-orm", "drizzle"],
  ["drizzle-kit", "drizzle"],
  ["mysql2", "mysql"],
  ["socket.io", "socketdotio"],
  ["socket.io-client", "socketdotio"],
  ["meilisearch", "meilisearch"],
  ["pnpm", "pnpm"],
  ["bun", "bun"],
  // 其余有官方字形的包：自备资产（见 BRAND_SOURCES 注释）与图标包已有的品牌
  ["jsdom", "jsdom"],
  ["sharp", "sharp"],
  ["esbuild", "esbuild"],
  ["postcss", "postcss"],
  ["eslint-plugin-sonarjs", "sonar"],
  ["@orpc/client", "orpc"],
  ["@orpc/contract", "orpc"],
  ["@lobehub/icons-static-svg", "lobehub"],
  // npm 别名：`typescript7` 装的就是 TypeScript 7，与 `typescript` 共用字形。
  ["typescript7", "typescript"],
]);

/**
 * scope / 包名前缀兜底。同一 scope 下的拆分包共用官方字形，
 * 按声明顺序取第一个命中，顺序固定、可预测；精确名始终优先于这里。
 */
const DEPENDENCY_BRAND_PREFIXES: readonly (readonly [string, CreditBrandId])[] = [
  ["@radix-ui/", "radixui"],
  ["@sentry/", "sentry"],
  ["@storybook/", "storybook"],
  ["@testing-library/", "testinglibrary"],
  ["@fortawesome/", "fontawesome"],
  ["@tailwindcss/", "tailwindcss"],
  ["@vitejs/", "vite"],
  ["@vitest/", "vitest"],
  ["@applemusic-like-lyrics/", "applemusic"],
  ["@eslint/", "eslint"],
  ["@playwright/", "playwright"],
  ["@elysiajs/", "elysia"],
  ["@socket.io/", "socketdotio"],
  ["@drizzle-team/", "drizzle"],
  ["@babel/", "babel"],
  ["@orpc/", "orpc"],
  // 前缀不带尾斜杠：`@fontsource` 同时覆盖 `@fontsource/*` 与 `@fontsource-variable/*`。
  ["@fontsource", "fontsource"],
  ["@lobehub/", "lobehub"],
  ["eslint-plugin-", "eslint"],
];

/** 包名 → 品牌键：精确名优先，再按前缀表取第一个命中；都不中返回 null。 */
function dependencyBrand(packageName: string): CreditBrandId | null {
  const exact = DEPENDENCY_BRANDS.get(packageName);
  if (exact !== undefined) return exact;
  for (const [prefix, brand] of DEPENDENCY_BRAND_PREFIXES) {
    if (packageName.startsWith(prefix)) return brand;
  }
  return null;
}

/** 依赖行图标：包名 → 品牌；没有匹配时回退 lucide 的通用包图标。 */
export function DependencyGlyph({ packageName, className }: { packageName: string; className?: string }): ReactNode {
  const brand = dependencyBrand(packageName);
  if (brand !== null) return renderBrand(BRAND_SOURCES[brand], className);
  return createElement(Package, { className: cn("size-4 shrink-0", className), "aria-hidden": true });
}
