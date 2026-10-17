import type { LucideIcon } from "lucide-react";
import { Boxes, Package, Server } from "lucide-react";
import { createElement } from "react";
// 逐图标引入：聚合入口无法被摇树，整包品牌图标会一起进产物。
import SiApplemusic from "@icons-pack/react-simple-icons/icons/SiApplemusic";
import SiBetterauth from "@icons-pack/react-simple-icons/icons/SiBetterauth";
import SiBun from "@icons-pack/react-simple-icons/icons/SiBun";
import SiDrizzle from "@icons-pack/react-simple-icons/icons/SiDrizzle";
import SiEslint from "@icons-pack/react-simple-icons/icons/SiEslint";
import SiFontawesome from "@icons-pack/react-simple-icons/icons/SiFontawesome";
import SiFramer from "@icons-pack/react-simple-icons/icons/SiFramer";
import SiLucide from "@icons-pack/react-simple-icons/icons/SiLucide";
import SiMeilisearch from "@icons-pack/react-simple-icons/icons/SiMeilisearch";
import SiMysql from "@icons-pack/react-simple-icons/icons/SiMysql";
import SiPnpm from "@icons-pack/react-simple-icons/icons/SiPnpm";
import SiPrettier from "@icons-pack/react-simple-icons/icons/SiPrettier";
import SiRadixui from "@icons-pack/react-simple-icons/icons/SiRadixui";
import SiReact from "@icons-pack/react-simple-icons/icons/SiReact";
import SiReactrouter from "@icons-pack/react-simple-icons/icons/SiReactrouter";
import SiSentry from "@icons-pack/react-simple-icons/icons/SiSentry";
import SiSimpleicons from "@icons-pack/react-simple-icons/icons/SiSimpleicons";
import SiSocketdotio from "@icons-pack/react-simple-icons/icons/SiSocketdotio";
import SiStorybook from "@icons-pack/react-simple-icons/icons/SiStorybook";
import SiTailwindcss from "@icons-pack/react-simple-icons/icons/SiTailwindcss";
import SiTestinglibrary from "@icons-pack/react-simple-icons/icons/SiTestinglibrary";
import SiTypescript from "@icons-pack/react-simple-icons/icons/SiTypescript";
import SiVite from "@icons-pack/react-simple-icons/icons/SiVite";
import SiVitest from "@icons-pack/react-simple-icons/icons/SiVitest";
import SiZod from "@icons-pack/react-simple-icons/icons/SiZod";
import type { TechStackIcon } from "@/lib/Credits";
import { cn } from "@/lib/Utils";

/** 品牌图标组件的类型；所有图标都是同一个生成类型，按其中一个取即可。 */
type BrandIcon = typeof SiReact;

/**
 * 依赖行图标：按 npm 包名精确匹配品牌图标。
 * 只收清单里实际会出现、且 simple-icons 有官方字形的包；其余走 `Package` 回退，不手绘。
 */
const DEPENDENCY_ICONS: Record<string, BrandIcon> = {
  react: SiReact,
  "react-dom": SiReact,
  typescript: SiTypescript,
  vite: SiVite,
  "@vitejs/plugin-react": SiVite,
  tailwindcss: SiTailwindcss,
  "@tailwindcss/vite": SiTailwindcss,
  "framer-motion": SiFramer,
  "lucide-react": SiLucide,
  zod: SiZod,
  vitest: SiVitest,
  storybook: SiStorybook,
  "@storybook/react-vite": SiStorybook,
  eslint: SiEslint,
  prettier: SiPrettier,
  "react-router-dom": SiReactrouter,
  "@testing-library/react": SiTestinglibrary,
  "@sentry/react": SiSentry,
  "@applemusic-like-lyrics/core": SiApplemusic,
  "@icons-pack/react-simple-icons": SiSimpleicons,
  "better-auth": SiBetterauth,
  pnpm: SiPnpm,
  bun: SiBun,
  "drizzle-orm": SiDrizzle,
  "socket.io-client": SiSocketdotio,
  mysql2: SiMysql,
  meilisearch: SiMeilisearch,
};

/**
 * 同一 scope 下的包共用官方字形：`@radix-ui/react-dialog`、`@sentry/react` 这类拆分包
 * 没有独立的品牌图标，按 scope 归一到它所属项目的字形。
 */
const DEPENDENCY_SCOPE_ICONS: readonly (readonly [string, BrandIcon])[] = [
  ["@radix-ui/", SiRadixui],
  ["@sentry/", SiSentry],
  ["@storybook/", SiStorybook],
  ["@testing-library/", SiTestinglibrary],
  ["@fortawesome/", SiFontawesome],
  ["@tailwindcss/", SiTailwindcss],
  ["@vitejs/", SiVite],
];

function dependencyBrandIcon(packageName: string): BrandIcon | null {
  const exact = DEPENDENCY_ICONS[packageName];
  if (exact) return exact;
  return DEPENDENCY_SCOPE_ICONS.find(([scope]) => packageName.startsWith(scope))?.[1] ?? null;
}

/**
 * 核心技术栈的品牌图标。Zustand 与 Elysia 在 simple-icons 里没有官方字形，回退 lucide，
 * 与项目「品牌图标只用于指向站外平台的链接、功能图标用 lucide」的约定一致。
 */
const TECH_STACK_ICONS: Partial<Record<TechStackIcon, BrandIcon>> = {
  react: SiReact,
  typescript: SiTypescript,
  vite: SiVite,
  tailwindcss: SiTailwindcss,
  framer: SiFramer,
  radixui: SiRadixui,
  bun: SiBun,
  drizzle: SiDrizzle,
  pnpm: SiPnpm,
  sentry: SiSentry,
};

const TECH_STACK_FALLBACKS: Partial<Record<TechStackIcon, LucideIcon>> = {
  zustand: Boxes,
  elysia: Server,
};

/** 依赖行前的品牌图标；包名没有对应字形时用通用包图标。装饰性图标，统一由调用处给尺寸与颜色。 */
export function DependencyGlyph({ packageName, className }: { packageName: string; className?: string }) {
  const Brand = dependencyBrandIcon(packageName);
  // 图标旁的包名已经说明了这是什么，图标不再贡献可访问名（清空 simple-icons 自带的 <title>）。
  const brandClassName = cn("size-4 shrink-0", className);
  if (Brand) return createElement(Brand, { title: "", className: brandClassName, "aria-hidden": true });
  return <Package className={brandClassName} aria-hidden="true" />;
}

/** 技术栈卡片的品牌图标；无品牌字形时用 lucide 的功能图标。 */
export function TechStackGlyph({ icon, className }: { icon: TechStackIcon; className?: string }) {
  const Brand = TECH_STACK_ICONS[icon];
  const glyphClassName = cn("size-5", className);
  if (Brand) return createElement(Brand, { title: "", className: glyphClassName, "aria-hidden": true });
  const Fallback = TECH_STACK_FALLBACKS[icon] ?? Package;
  return <Fallback className={glyphClassName} aria-hidden="true" />;
}
