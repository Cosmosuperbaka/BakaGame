/**
 * 可收录页面的元信息与静态外壳内容（单一真相源）。
 *
 * 为什么集中在这里：同一份文案有两个消费者——
 *   1. 页面组件的 `Seo`（运行时把标签写进 head）；
 *   2. 构建期的静态外壳注入（`vite.config.ts` 的 staticShellPlugin，把正文与 head 标签写进 dist 的 HTML）。
 * 分散在两处必然漂移：改了描述忘了改外壳，爬虫与用户拿到的就不是同一份内容。
 *
 * 本模块必须保持零依赖（不 import React、组件或任何浏览器 API），因为 vite.config
 * 在构建期（Node 环境）也要读它。结构化数据用纯字面量表达，避免把组件层的类型带进来。
 */

export const SITE_ORIGIN = "https://game.baka.website";
export const SITE_NAME = "BakaGame";

/** 静态外壳：不执行 JS 的爬虫（百度为主）能读到的正文。 */
export interface PageShell {
  /** 外壳 H1 */
  h1: string;
  /** 外壳段落 */
  paragraphs: string[];
  /** 外壳内的站内链接 */
  links: { href: string; label: string }[];
}

export interface PageMeta {
  /** 站内路径；静态外壳按它决定落盘位置 */
  path: string;
  /** meta description 与 og:description */
  description: string;
  shell: PageShell;
  /** JSON-LD 结构化数据 */
  structuredData: Record<string, unknown>;
}

export const PAGE_META: PageMeta[] = [
  {
    path: "/",
    description:
      "BakaGame 是免下载的网页版多人派对游戏站，提供在线版谁是卧底与听歌猜歌两款游戏，支持 4 至 16 人实时联机、单人练习与断线重连，打开浏览器即可开玩。",
    shell: {
      h1: "BakaGame：免下载的网页版派对游戏站",
      paragraphs: [
        "BakaGame（二刺猿笑传之猜猜呗）提供两款打开浏览器就能玩的联机游戏：在线版谁是卧底与听歌猜歌。两款游戏都支持 4 至 16 人实时联机、单人练习与断线重连，不需要下载或注册。",
        "谁是卧底支持出题人自由出题、平票 PK、补充发言与白板猜词；听歌猜歌可以直接对唱，也可以猜番剧，曲库来自网易云音乐与 Bangumi 番剧库。",
      ],
      links: [
        { href: "/whoisfaker", label: "进入谁是卧底" },
        { href: "/songuessr", label: "进入听歌猜歌" },
      ],
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "BakaGame",
      alternateName: "二刺猿笑传之猜猜呗",
      url: `${SITE_ORIGIN}/`,
      inLanguage: "zh-CN",
      description: "免下载的网页版多人派对游戏站，提供在线版谁是卧底与听歌猜歌。",
    },
  },
  {
    path: "/whoisfaker",
    description:
      "BakaGame 在线版谁是卧底，免下载直接开玩。支持 4 至 16 人实时联机，含发言投票、平票加赛、补充发言、夜间行动与白板猜词等完整流程，8 人以上出现白板，支持观战与断线重连。",
    shell: {
      h1: "Who is Faker：在线版谁是卧底",
      paragraphs: [
        "在线版谁是卧底，免下载直接开玩。参战玩家至少 4 人，另需 1 名出题人；卧底人数按每 4 人配 1 名计算，向上取整。",
        "完整流程包含轮流描述、全员投票、平票 PK、补充发言与夜晚行动，8 人及以上可以加入白板，支持观战与断线重连，重连后回到原来的座位与身份。",
      ],
      links: [
        { href: "/", label: "返回主页" },
        { href: "/songuessr", label: "听歌猜歌" },
      ],
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Who is Faker 在线谁是卧底",
      applicationCategory: "GameApplication",
      operatingSystem: "Web",
      url: `${SITE_ORIGIN}/whoisfaker`,
      inLanguage: "zh-CN",
      description: "免下载的在线版谁是卧底，支持 4 至 16 人实时联机。",
      offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
    },
  },
  {
    path: "/songuessr",
    description:
      "Songuessr 是免下载的网页版听歌猜歌游戏，播放歌曲片段竞猜歌名或番剧，支持单人练习与多人联机对战，曲库接自网易云音乐与 Bangumi 番剧库。",
    shell: {
      h1: "Songuessr：在线听歌猜歌",
      paragraphs: [
        "播放歌曲片段，竞猜歌名或番剧。单人模式自己练手，多人模式在同一房间里同时开猜，每轮默认 3 次提交机会、单次 60 秒倒计时。",
        "每次提交都会给出方向性反馈（发行年份、热度、语言、共同标签），把答案一步步收敛到目标；曲库接自网易云音乐，番剧数据来自 Bangumi。",
      ],
      links: [
        { href: "/", label: "返回主页" },
        { href: "/whoisfaker", label: "谁是卧底" },
      ],
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Songuessr 听歌猜歌",
      applicationCategory: "GameApplication",
      operatingSystem: "Web",
      url: `${SITE_ORIGIN}/songuessr`,
      inLanguage: "zh-CN",
      description: "免下载的网页版听歌猜歌游戏，支持单人练习与多人联机。",
      offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
    },
  },
  {
    path: "/ccb",
    description:
      "CCB（二刺猿笑传之猜猜呗）是免下载的网页版猜动漫角色游戏，同一房间内所有玩家同时猜同一个角色，逐字段反馈把答案一步步收敛，角色与作品数据来自 Bangumi 本地库。",
    shell: {
      h1: "CCB：在线猜动漫角色",
      paragraphs: [
        "同一房间内所有人猜同一个动漫角色。每次提交都会给出逐字段反馈——性别、热度区间、作品评分、登场年、共同出演作品与共同标签，把范围一步步收敛到唯一答案。",
        "房间支持公开与私密、准备开局、旁观、聊天与房主管理；角色与作品数据来自本地 Bangumi 数据集，无需等待第三方接口。",
      ],
      links: [
        { href: "/", label: "返回主页" },
        { href: "/whoisfaker", label: "谁是卧底" },
        { href: "/songuessr", label: "Songuessr 听歌猜歌" },
      ],
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "CCB 猜动漫角色",
      applicationCategory: "GameApplication",
      operatingSystem: "Web",
      url: `${SITE_ORIGIN}/ccb`,
      inLanguage: "zh-CN",
      description: "免下载的网页版猜动漫角色游戏，支持多人同房竞猜。",
      offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
    },
  },
];

/**
 * 按路径取页面元信息。未登记的路径（房间页、单人页等运行时页面）返回 undefined，
 * 由调用方显式提供 description——这些页面已标 noindex，不进静态外壳。
 */
export function findPageMeta(path: string): PageMeta | undefined {
  return PAGE_META.find((item) => item.path === path);
}
