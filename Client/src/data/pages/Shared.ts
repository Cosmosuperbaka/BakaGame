/**
 * 页面元信息的公共骨架：站点常量、形状定义与 head/结构化数据助手。
 *
 * 为什么单独成模块：各页文案（`data/pages/<页>.ts`）与枢纽 `PageMeta.ts` 都要引用这些常量，
 * 若放在 PageMeta.ts 里会与各页文件互相 import 成环。骨架不依赖任何页面，环就断在这里。
 *
 * 本模块必须保持零依赖（不 import React、组件或任何浏览器 API），因为 vite.config
 * 在构建期（Node 环境）也要读它。结构化数据用纯字面量表达，避免把组件层的类型带进来。
 */

import { SITE_NAME, SITE_PAGE_ENTRIES } from "../../../../Server/src/shared/SitePages.ts";

export const SITE_ORIGIN = "https://game.baka.website";
// 站名与公开页的路径、短标题是服务端 Agent 地图共用的登记，只在共享契约里写一份。
export { SITE_NAME, SITE_PAGE_ENTRIES };

/** 站点标语本体：首页标题用它，不带句号。 */
export const SITE_SLOGAN = "1000万以内最好玩的小游戏网站";

/**
 * 分享标语：每个登记页面的 description 第一句都必须是它。
 * 社媒卡片正文由 og:description 渲染，抓取器普遍只展示前两行——最想让人看到的一句
 * 放在最前面，写在正文之后会被直接截掉。构建期断言与 SEO E2E 都以它为约束。
 */
export const SITE_TAGLINE = `${SITE_SLOGAN}。`;

/**
 * 分享卡片尺寸：大图卡片的通行规格。源图由 `scripts/og-cards.mjs` 按这个尺寸出图，
 * 构建期逐张校验，尺寸不对直接失败；head 里的 og:image:width / height 也取这里。
 */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/** 未登记页面（房间、运行时页）的分享图：站点卡片。 */
export const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/og/og-home.jpg`;
export const DEFAULT_OG_IMAGE_ALT =
  "BakaGame 分享卡片：站名与谁是卧底、听歌猜歌、猜动漫角色三款游戏";

/**
 * 公开代码仓库。页脚外链、提交历史的取数接口与提交页跳转都从这里取，
 * 免得同一串地址在三个地方各写一份、改一处漏两处。
 */
export const REPOSITORY_URL = "https://github.com/Cosmosuperbaka/BakaGame";

/** 静态外壳：不执行 JS 的爬虫（百度为主）能读到的正文。 */
export interface PageShell {
  /** 外壳 H1 */
  h1: string;
  /** 外壳段落 */
  paragraphs: string[];
  /**
   * 带小标题的正文段：AI 检索按段落切片，小标题让每段单独取出来也读得懂。
   * 只写玩法的真实事实，数字以代码与数据为准。
   */
  sections?: { heading: string; paragraphs: string[] }[];
  /** 外壳内的站内链接 */
  links: { href: string; label: string }[];
}

/** 常见问答条目：构建期写进静态外壳正文，并派生成 FAQPage 结构化数据。 */
export interface PageFaqItem {
  /** 问题 */
  q: string;
  /** 回答 */
  a: string;
}

export interface PageMeta {
  /** 站内路径；静态外壳按它决定落盘位置 */
  path: string;
  /** 标签页标题与 og:title：写页面是什么，不堆搜索词 */
  title: string;
  /** 短名：面包屑与站内链接文字用，不带站名后缀 */
  shortTitle: string;
  /**
   * 一句话简介：首页游戏卡片下的那一行与分享卡片上的那一行，只写事实，不写口号。
   * 只有首页与三款游戏有。
   */
  oneLiner?: string;
  /**
   * 站点地图的 lastmod（YYYY-MM-DD）。只在页面文案或结构有显著变更时更新：
   * 每次构建都刷新会让搜索引擎判定该字段不可信，进而整体忽略它（不写比写错好）。
   */
  lastmod?: string;
  /** meta description 与 og:description；第一句固定为分享标语 `SITE_TAGLINE` */
  description: string;
  /**
   * 社交媒体分享图（og:image）。本站图统一用 `${SITE_ORIGIN}/og/<名>.jpg`：
   * 全站图片管线只产 webp，而部分分享抓取器（QQ 实测）不认 webp，卡片显示不出图；
   * 构建期 `seo-artifacts` 插件从 `src/assets/og/<名>.png`（`scripts/og-cards.mjs` 出的卡片）
   * 转出 jpg，并校验尺寸为 OG_IMAGE_WIDTH × OG_IMAGE_HEIGHT。
   */
  image?: string;
  /** 分享图的替代文字（og:image:alt）：写图上画了什么 */
  imageAlt?: string;
  /** 供爬虫索引与归类的关键词列表（用户不可见） */
  keywords?: string[];
  /**
   * 每页的常见问答（用户不可见）：构建期注入静态外壳正文与 FAQPage 结构化数据，
   * 运行时由 `Seo` 按固定 id 重建同一份数据；两处共用 `buildFaqStructuredData`，
   * 避免 JSON-LD 结构漂移。缺问答或问答不合法会被构建期断言拦下。
   */
  faq: PageFaqItem[];
  shell: PageShell;
  /** JSON-LD 结构化数据 */
  structuredData: Record<string, unknown>;
}

/**
 * 三款游戏与首页的一句话介绍。description、静态外壳正文与结构化数据共用这几句：
 * 结构化数据必须和页面正文说同一件事，分开写迟早漂移。
 */
export const HOME_SUMMARY =
  "BakaGame 是一间开给二次元朋友的游戏室：Who is Faker 谁是卧底比谁会装，Songuessr 听歌猜歌比谁耳朵灵，CEE 猜动漫角色比谁的番没白看。";
export const FAKER_SUMMARY =
  "Who is Faker 是出题人现场写词的谁是卧底：谁都不知道自己拿的是平民词还是卧底词，描述和投票之后还要入夜，平民动刀，倒下的是自己。";
export const SONG_SUMMARY =
  "Songuessr 是给番剧党和歌单党准备的听歌猜歌：听一段音乐，猜歌名，或者猜这首 OP、ED 出自哪部番。";
export const CEE_SUMMARY =
  "CEE（二刺猿笑传之猜猜呗增强版）是多人猜动漫角色：全房猜同一个角色，从二十多万条 Bangumi 角色资料里，靠性别、登场年份、作品评分和标签一路排除。";
export const ABOUTS_SUMMARY =
  "BakaGame 的开源致谢、玩家更新日志、提交历史、隐私说明与用户条款。开源致谢列出技术栈、参与开发的大模型和全部前端依赖的许可证。";

/** 站点组织实体的节点 id：首页写完整实体，其它页按 id 引用。 */
export const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;

/** 三款游戏共用的结构化数据字段：都是房间制的网页游戏，不收费，界面为中文。 */
export const GAME_ENTITY = {
  "@context": "https://schema.org",
  // VideoGame 给出人数与玩法模式，WebApplication 说明它跑在网页上。
  "@type": ["VideoGame", "WebApplication"],
  applicationCategory: "GameApplication",
  operatingSystem: "Web Browser",
  gamePlatform: ["Web Browser", "Windows", "Android"],
  inLanguage: "zh-CN",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
} as const;

/**
 * 运行时页（房间、单人、排位、状态、后台）与 404 的静态外壳：只写标题、描述与分享卡片字段，
 * 一律 noindex，不写 canonical、正文与 FAQ。托管平台把这类地址改写到对应文件后，
 * 不执行脚本的抓取器与聊天软件的链接预览读到的就是这里，而不是首页外壳。
 * 房间邀请的描述是固定文案：外壳是构建期产物，本来也拿不到房号；不要尝试拼房号或房间名。
 */
export interface RuntimePageMeta {
  /** 产物里的文件名（相对产物根目录） */
  file: string;
  title: string;
  description: string;
  image: string;
  imageAlt: string;
}

/** 一条 head 标签：构建期序列化成字符串，运行时渲染成 React 元素，两处从同一份列表出发。 */
export interface HeadTag {
  kind: "meta" | "link";
  /** 属性按书写顺序输出 */
  attrs: Record<string, string>;
}

export interface HeadTagInput {
  /**
   * 站内路径（以 / 开头），用于 canonical 与 og:url。
   * 运行时页的静态外壳省略它：一份外壳服务一类地址，写哪个 canonical 都是错的。
   */
  path?: string;
  title: string;
  description: string;
  image?: string;
  imageAlt?: string;
  keywords?: string[];
  indexable: boolean;
}

/**
 * 页面的 head 标签集合（不含 `<title>` 与 JSON-LD）。
 * 静态外壳与运行时 `Seo` 共用：加一个标签只改这里，两边不会一边有一边没有。
 */
export function buildHeadTags(input: HeadTagInput): HeadTag[] {
  const canonical = input.path === undefined ? undefined : `${SITE_ORIGIN}${input.path}`;
  const image = input.image ?? DEFAULT_OG_IMAGE;
  const imageAlt = input.image ? input.imageAlt : DEFAULT_OG_IMAGE_ALT;
  // 站内分享卡片都按同一尺寸出图（构建期校验），宽高可以直接写；外链图尺寸未知，不写。
  const isSiteCard = image.startsWith(`${SITE_ORIGIN}/og/`);
  const meta = (attrs: Record<string, string>): HeadTag => ({ kind: "meta", attrs });
  return [
    meta({ name: "description", content: input.description }),
    ...(input.keywords && input.keywords.length > 0
      ? [meta({ name: "keywords", content: input.keywords.join(", ") })]
      : []),
    ...(canonical ? [{ kind: "link" as const, attrs: { rel: "canonical", href: canonical } }] : []),
    meta({ name: "robots", content: input.indexable ? "index,follow" : "noindex,follow" }),
    meta({ property: "og:type", content: "website" }),
    meta({ property: "og:site_name", content: SITE_NAME }),
    meta({ property: "og:title", content: input.title }),
    meta({ property: "og:description", content: input.description }),
    meta({ property: "og:image", content: image }),
    ...(isSiteCard
      ? [
          meta({ property: "og:image:width", content: String(OG_IMAGE_WIDTH) }),
          meta({ property: "og:image:height", content: String(OG_IMAGE_HEIGHT) }),
        ]
      : []),
    ...(imageAlt ? [meta({ property: "og:image:alt", content: imageAlt })] : []),
    ...(canonical ? [meta({ property: "og:url", content: canonical })] : []),
    meta({ name: "twitter:card", content: "summary_large_image" }),
    meta({ name: "twitter:title", content: input.title }),
    meta({ name: "twitter:description", content: input.description }),
    meta({ name: "twitter:image", content: image }),
    ...(imageAlt ? [meta({ name: "twitter:image:alt", content: imageAlt })] : []),
  ];
}

/**
 * 两级面包屑（站点首页 → 本页）。首页自己就是根，返回 null，调用方据此不注入（或移除）。
 * 构建期外壳与运行时 `Seo` 共用本函数。
 */
export function buildBreadcrumbStructuredData(
  meta: Pick<PageMeta, "path" | "shortTitle"> | undefined
): Record<string, unknown> | null {
  if (!meta || meta.path === "/") return null;
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_ORIGIN}/` },
      {
        "@type": "ListItem",
        position: 2,
        name: meta.shortTitle,
        item: `${SITE_ORIGIN}${meta.path}`,
      },
    ],
  };
}

/**
 * 由 FAQ 条目派生 FAQPage 结构化数据。
 * 构建期外壳与运行时 `Seo` 共用本函数：同一份问答在两处的 JSON-LD 结构不会漂移。
 * 无问答时返回 null，调用方据此不注入（或移除）对应脚本。
 */
export function buildFaqStructuredData(
  faq: PageFaqItem[] | undefined
): Record<string, unknown> | null {
  if (!faq || faq.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}
