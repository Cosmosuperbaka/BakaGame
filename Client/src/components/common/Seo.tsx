import { useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { SITE_NAME, SITE_ORIGIN, findPageMeta } from "@/data/PageMeta";

/** JSON-LD 脚本在 <head> 中的固定 id，用于跨页面切换时先移除旧数据再写入新数据。 */
const STRUCTURED_DATA_ID = "bakagame-structured-data";

interface SeoProps {
  /** 站内路径（以 / 开头）；用于生成 canonical 与 og:url，并据此查 PageMeta。 */
  path: string;
  /** 页面描述。已登记在 `PageMeta` 的路径可省略，自动取单一真相源。 */
  description?: string;
  /** 是否允许搜索引擎索引本页。房间页等运行时页面应传 false。 */
  indexable?: boolean;
  /** 结构化数据对象；已登记路径默认取 `PageMeta`，可用此属性覆盖。 */
  structuredData?: Record<string, unknown>;
}

/**
 * 声明式页面元信息。
 *
 * 文案与结构化数据来自 `@/data/PageMeta`（单一真相源）：同一份数据在构建期被静态外壳
 * 注入器复用，因此页面与爬虫拿到的描述永远一致。未登记的路径（房间页、单人页）由调用方
 * 显式传 description——这些页面已标 noindex，不进静态外壳。
 *
 * 之所以引入 react-helmet-async 而不是把 meta 写死在 index.html：
 * 本站是 SPA，多个页面需要各自独立的 description 与 canonical，写死在入口 HTML 里
 * 只能覆盖首页一种情况，其余页面在搜索结果中会共用首页描述，造成描述缺失与 canonical 错指。
 *
 * 浏览器标签页标题刻意不在此管理：产品决策（2026-09-14）要求所有页面统一显示纯站名
 * 「BakaGame」，不带任何后缀，由 index.html 的兜底 <title> 提供。本组件因此不渲染 <title>，
 * og:title 也固定为站名。
 */
export function Seo({ path, description, indexable = true, structuredData }: SeoProps) {
  const meta = findPageMeta(path);
  const resolvedDescription = description ?? meta?.description;
  if (!resolvedDescription) {
    // 宁可当场报错，也不要静默产出一个空 description 的页面：那等于把页面交给搜索引擎瞎猜。
    throw new Error(`Seo：路径 ${path} 未登记在 PageMeta，且未显式传入 description`);
  }

  const canonical = `${SITE_ORIGIN}${path}`;
  const resolvedStructuredData = structuredData ?? meta?.structuredData;
  const structuredDataJson = resolvedStructuredData ? JSON.stringify(resolvedStructuredData) : null;

  // 结构化数据不走 Helmet：Helmet 在 React 19 下把 <script> 渲染成 React 元素，
  // 交给 React 的 head 提升机制插入，该行为依赖运行时实现、在预渲染与测试环境下
  // 会落到 <body> 里，位置不可控。JSON-LD 必须稳定落在 <head>，因此手动管理。
  // 构建期静态外壳已写入同 id 的脚本，这里按 id 复用并覆盖内容，不会产生重复标签。
  useEffect(() => {
    if (!structuredDataJson) return;

    const existing = document.getElementById(STRUCTURED_DATA_ID);
    const script = (existing as HTMLScriptElement | null) ?? document.createElement("script");
    script.id = STRUCTURED_DATA_ID;
    script.type = "application/ld+json";
    script.textContent = structuredDataJson;

    if (!existing) document.head.appendChild(script);
  }, [structuredDataJson]);

  return (
    <Helmet prioritizeSeoTags>
      <meta name="description" content={resolvedDescription} />
      <link rel="canonical" href={canonical} />
      <meta name="robots" content={indexable ? "index,follow" : "noindex,follow"} />

      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={SITE_NAME} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonical} />
    </Helmet>
  );
}

export { SITE_ORIGIN, SITE_NAME };
