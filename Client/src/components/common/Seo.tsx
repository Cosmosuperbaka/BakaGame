import { useEffect } from "react";
import { Helmet } from "react-helmet-async";

/** 站点根地址，所有绝对 URL（canonical、og:url）都以此为准。 */
const SITE_ORIGIN = "https://game.baka.website";
const SITE_NAME = "BakaGame";

/** JSON-LD 脚本在 <head> 中的固定 id，用于跨页面切换时先移除旧数据再写入新数据。 */
const STRUCTURED_DATA_ID = "bakagame-structured-data";

interface SeoProps {
  /** 页面标题，写入 <title> 与 og:title。 */
  title: string;
  /** 页面描述，写入 meta description 与 og:description。 */
  description: string;
  /** 站内路径（以 / 开头）；用于生成 canonical 与 og:url。 */
  path: string;
  /** 是否允许搜索引擎索引本页。房间页等运行时页面应传 false。 */
  indexable?: boolean;
  /** 结构化数据对象，序列化后写入 JSON-LD 脚本。 */
  structuredData?: Record<string, unknown>;
}

/**
 * 声明式页面元信息。
 *
 * 之所以引入 react-helmet-async 而不是把 meta 写死在 index.html：
 * 本站是 SPA，三个页面（首页 / 两个游戏大厅）需要各自独立的 title 与 description，
 * 写死在入口 HTML 里只能覆盖首页一种情况，其余页面在搜索结果中会共用首页标题，
 * 造成标题重复与描述缺失。
 *
 * 这些标签同样服务于预渲染：预渲染阶段 React 会真实执行本组件，
 * Helmet 收集到的标签会被序列化进静态 HTML，爬虫无需执行 JS 即可读到。
 */
export function Seo({ title, description, path, indexable = true, structuredData }: SeoProps) {
  const canonical = `${SITE_ORIGIN}${path}`;
  const structuredDataJson = structuredData ? JSON.stringify(structuredData) : null;

  // 结构化数据不走 Helmet：Helmet 在 React 19 下把 <script> 渲染成 React 元素，
  // 交给 React 的 head 提升机制插入，该行为依赖运行时实现、在预渲染与测试环境下
  // 会落到 <body> 里，位置不可控。JSON-LD 必须稳定落在 <head>，因此手动管理。
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
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={canonical} />
      <meta name="robots" content={indexable ? "index,follow" : "noindex,follow"} />

      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonical} />
    </Helmet>
  );
}

export { SITE_ORIGIN, SITE_NAME };
