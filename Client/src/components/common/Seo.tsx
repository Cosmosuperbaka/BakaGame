import { useEffect, useLayoutEffect } from "react";
import { resolveSeo } from "@/lib/ResolveSeo";

/** 结构化数据脚本在 <head> 中的固定 id，用于跨页面切换时先移除旧数据再写入新数据。 */
const STRUCTURED_DATA_ID = "bakagame-structured-data";
/** FAQPage 结构化数据的固定 id；与构建期静态外壳写入的脚本共用同一套「按 id 覆盖」机制。 */
const FAQ_STRUCTURED_DATA_ID = "bakagame-faq-structured-data";
/** 面包屑的固定 id；首页与未登记页没有面包屑，切过去时移除。 */
const BREADCRUMB_STRUCTURED_DATA_ID = "bakagame-breadcrumb-structured-data";

/**
 * 按固定 id 管理 <head> 里的一份 JSON-LD：已存在则原地覆盖内容，内容为空则移除。
 *
 * 为什么手动管理而不是直接渲染 <script>：React 19 只提升带 src 的异步脚本，
 * 内联的 JSON-LD 会留在组件所在位置（落进 <body>），位置不可控。JSON-LD 必须稳定落在 <head>，
 * 因此手动管理。构建期静态外壳已写入同 id 的脚本，这里按 id 复用并覆盖内容，不会产生重复标签。
 */
function useStructuredDataScript(id: string, json: string | null) {
  useEffect(() => {
    const existing = document.getElementById(id);
    if (!json) {
      existing?.remove();
      return;
    }

    const script = (existing as HTMLScriptElement | null) ?? document.createElement("script");
    script.id = id;
    script.type = "application/ld+json";
    script.textContent = json;

    if (!existing) document.head.appendChild(script);
  }, [id, json]);
}

interface SeoProps {
  /** 站内路径（以 / 开头）；用于生成 canonical 与 og:url，并据此查 PageMeta。 */
  path: string;
  /** 页面标题。已登记在 `PageMeta` 的路径可省略；未登记且未传时退回站名。 */
  title?: string;
  /** 页面描述。已登记在 `PageMeta` 的路径可省略，自动取单一真相源。 */
  description?: string;
  /** 社交媒体预览大图。已登记在 `PageMeta` 的路径可省略。 */
  image?: string;
  /** 供搜索引擎索引的关键词。已登记在 `PageMeta` 的路径可省略。 */
  keywords?: string[];
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
 * 为什么不是把 meta 写死在 index.html：本站是 SPA，多个页面需要各自独立的 description
 * 与 canonical，写死在入口 HTML 里只能覆盖首页一种情况，其余页面在搜索结果中会共用首页描述，
 * 造成描述缺失与 canonical 错指。
 *
 * 渲染方式：description、canonical、robots 与分享字段直接渲染 <meta>/<link>，由 React 19
 * 提升到 <head>，页面卸载时随之移除。标题不走元素提升，而是改写 <head> 里已有的那个
 * <title>：静态外壳的标题不随启动清理摘掉（页面分块下载期间标签页标题必须仍是外壳写的那个），
 * 若再让 React 另插一个 <title>，head 里会有两份，`document.title` 只认第一个。
 * 结构化数据见上方 `useStructuredDataScript`。
 */
export function Seo({
  path,
  title,
  description,
  image,
  keywords,
  indexable,
  structuredData,
}: SeoProps) {
  const {
    title: resolvedTitle,
    headTags,
    structuredDataJson,
    faqStructuredDataJson,
    breadcrumbStructuredDataJson,
  } = resolveSeo({ path, title, description, image, keywords, indexable, structuredData });

  // 布局副作用：与页面内容同一次提交里写完，不会出现新页面已显示、标签页标题还是上一页的帧。
  useLayoutEffect(() => {
    document.title = resolvedTitle;
  }, [resolvedTitle]);

  useStructuredDataScript(STRUCTURED_DATA_ID, structuredDataJson);
  useStructuredDataScript(FAQ_STRUCTURED_DATA_ID, faqStructuredDataJson);
  useStructuredDataScript(BREADCRUMB_STRUCTURED_DATA_ID, breadcrumbStructuredDataJson);

  return (
    <>
      {headTags.map((tag) => {
        const key = Object.values(tag.attrs)[0];
        return tag.kind === "meta" ? (
          <meta key={key} {...tag.attrs} />
        ) : (
          <link key={key} {...tag.attrs} />
        );
      })}
    </>
  );
}
