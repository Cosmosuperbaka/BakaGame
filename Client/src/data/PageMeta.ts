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
  /** 社交媒体预览大图（绝对地址或相对站内路径） */
  image?: string;
  /** 供爬虫索引与归类的关键词列表（用户不可见） */
  keywords?: string[];
  shell: PageShell;
  /** JSON-LD 结构化数据 */
  structuredData: Record<string, unknown>;
}

export const PAGE_META: PageMeta[] = [
  {
    path: "/",
    description:
      "叫上朋友即刻开黑！BakaGame 专为聚会与二次元同好打造的多人联机对战站：涵盖谁是卧底语言博弈、动漫与流行歌曲/番剧竞猜（Songuessr）、以及 Bangumi 角色线索竞猜（CCB）。拉个房间随时开局，找回纯粹的联机快乐！",
    image: `${SITE_ORIGIN}/assets/logo.webp`,
    keywords: [
      "BakaGame",
      "派对游戏",
      "联机对战",
      "谁是卧底",
      "听歌猜歌",
      "猜番剧",
      "猜动漫角色",
      "二次元小游戏",
      "聚会开黑",
    ],
    shell: {
      h1: "BakaGame：二次元与聚会联机游戏站",
      paragraphs: [
        "BakaGame 专注于轻快硬核的多人联机派对游戏。集合了包含白板与天使机制的谁是卧底、联动网易云与 Bangumi 的歌曲及番剧竞猜（Songuessr）、以及基于数十万角色库线索收敛的 CCB 猜动漫角色。丢个链接即可加入房间，支持实时聊天与断线秒级重连。",
        "无论是聚会破冰、群友摸鱼还是二次元浓度大比拼：在谁是卧底里狂飙演技，在猜歌房抢答番剧 OP/ED，或在 CCB 里通过角色 BP 斗智斗勇。所有模式均支持自由开房联机。",
      ],
      links: [
        { href: "/whoisfaker", label: "进入谁是卧底" },
        { href: "/songuessr", label: "进入音乐与番剧竞猜" },
        { href: "/ccb", label: "进入猜动漫角色" },
      ],
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "BakaGame",
      alternateName: ["二刺猿笑传之猜猜呗", "Who is Faker", "Songuessr", "CCB"],
      url: `${SITE_ORIGIN}/`,
      inLanguage: "zh-CN",
      description:
        "专为聚会与二次元同好打造的多人联机对战游戏站，包含谁是卧底、听歌猜番与猜动漫角色。",
    },
  },
  {
    path: "/whoisfaker",
    description:
      "聚会必备的语言推理与心理博弈！在线谁是卧底（Who is Faker）支持 4~16 人实时联机，自带自由出题、全员投票、平票加赛与夜晚行动；更有 8 人局专属白板背水反杀与天使双词护盾机制。带好演技进房，看看这局谁在一本正经胡说八道！",
    image: `${SITE_ORIGIN}/assets/Faker.webp`,
    keywords: [
      "谁是卧底",
      "在线版谁是卧底",
      "文字推理",
      "聚会桌游",
      "白板猜词",
      "天使护盾",
      "心理博弈",
      "Who is Faker",
    ],
    shell: {
      h1: "Who is Faker：在线版谁是卧底",
      paragraphs: [
        "经典语言推理派对游戏在线版谁是卧底。支持 4 至 16 名玩家同台博弈，出题人自由出题，系统自动分发平民、卧底与特殊身份。支持平票加赛、局外观战与断线即时重连，重连后完整保留席位与身份。",
        "进阶玩法体验拉满：支持 8 人开启无词靠词性翻盘的「白板」、可选阵营与自带护盾的「天使」，以及死亡身份即时揭露开关。比拼口才、逻辑与演技，找出藏在身边的卧底。",
      ],
      links: [
        { href: "/", label: "返回主页" },
        { href: "/songuessr", label: "音乐与番剧竞猜" },
        { href: "/ccb", label: "猜动漫角色" },
      ],
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Who is Faker 在线谁是卧底",
      applicationCategory: "GameApplication",
      operatingSystem: "Web Browser",
      url: `${SITE_ORIGIN}/whoisfaker`,
      inLanguage: "zh-CN",
      description: "支持 4 至 16 人的在线语言推理派对游戏，具备白板、天使、平票加赛等深度博弈机制。",
      featureList: [
        "4 至 16 人实时联机",
        "自由出题与题库分发",
        "8人局白板猜词反杀机制",
        "天使双词与护盾机制",
        "平票 PK 加赛与断线无缝重连",
      ],
      offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
    },
  },
  {
    path: "/songuessr",
    description:
      "不仅是听歌猜歌，更是番剧阅历的大考！Songuessr 联动网易云音乐与 Bangumi，支持「猜歌名」与「猜番剧」双赛道。享受逐字渐变点亮歌词演出，在年份、热度与标签偏差的线索收敛中锁定答案，支持单人练习挑战与多人同屏血战抢答。",
    image: `${SITE_ORIGIN}/assets/SongGuessr.webp`,
    keywords: [
      "Songuessr",
      "听歌猜歌",
      "猜番剧",
      "动漫音乐竞猜",
      "动漫OP ED",
      "网易云音乐猜歌",
      "Bangumi番剧",
      "逐字歌词",
      "ACG音乐",
    ],
    shell: {
      h1: "Songuessr：音乐与动漫番剧竞猜",
      paragraphs: [
        "听前奏、辨歌词、猜番剧！Songuessr 深度联动网易云音乐曲库与 Bangumi 番剧资料库，涵盖动漫 OP、ED、插曲、角色歌、OST 与流行金曲。支持「猜歌名」与「猜番剧」双重出题模式，既可轮流手动点歌，也能按年份与热度智能抽题。",
        "内置 Apple Music 风格逐字歌词动效（亦可盲听隐藏歌词），搭配智能音频平滑切片。独创 Wordle 式反馈系统：每次提交提示发行年代偏差、热度区间、语种与共同标签，配合血战抢分机制，在手速与知识面的碰撞中锁定正确答案。",
      ],
      links: [
        { href: "/", label: "返回主页" },
        { href: "/whoisfaker", label: "谁是卧底" },
        { href: "/ccb", label: "猜动漫角色" },
      ],
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Songuessr 听歌猜歌与番剧竞猜",
      applicationCategory: "GameApplication",
      operatingSystem: "Web Browser",
      url: `${SITE_ORIGIN}/songuessr`,
      inLanguage: "zh-CN",
      description: "联动网易云与 Bangumi 的音乐及番剧竞猜游戏，支持猜歌名与猜番剧双赛道、逐字歌词及多维线索收敛。",
      featureList: [
        "「猜歌名」与「猜番剧」双重竞猜赛道",
        "联动网易云音乐与 Bangumi 番剧库",
        "Apple Music 风格逐字渐变歌词播放器",
        "发行年份、热度与标签偏差的 Wordle 式收敛反馈",
        "单人无尽练习与多人血战抢分模式",
      ],
      offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
    },
  },
  {
    path: "/ccb",
    description:
      "二次元阅历的终极考场！CCB（二刺猿笑传之猜猜呗）猜动漫角色游戏。基于百万级 Bangumi 资料库，全员同房竞猜唯一角色。从性别、年代、作品评分、声优到作品标签层层排除，更有组队对抗、角色全局 BP 与原版协议互通。测测你的二次元浓度上限！",
    image: `${SITE_ORIGIN}/assets/CCB.webp`,
    keywords: [
      "CCB",
      "二刺猿笑传之猜猜呗",
      "猜动漫角色",
      "在线猜动漫角色",
      "Bangumi",
      "动漫知识竞猜",
      "角色BP",
      "动漫Wordle",
    ],
    shell: {
      h1: "CCB：在线猜动漫角色（二刺猿笑传之猜猜呗）",
      paragraphs: [
        "专属于动漫爱好者的硬核角色竞猜——在线猜动漫角色。基于百万级 Bangumi 角色资料库，所有人竞猜同一个目标角色。每次提交角色都会实时反馈性别、作品登场年、评分、出演作品重合度与角色标签，像侦探一样抽丝剥茧逼近真相。",
        "玩法深度拉满：支持个人混战与组队对抗、轮流出题、模糊立绘渐进提示，以及「角色全局 BP」与「标签全局 BP」高阶战术规则。增强版房间更全面兼容原版 CCB 联机协议，老二刺猿速来集合！",
      ],
      links: [
        { href: "/", label: "返回主页" },
        { href: "/whoisfaker", label: "谁是卧底" },
        { href: "/songuessr", label: "音乐与番剧竞猜" },
      ],
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "CCB 猜动漫角色",
      applicationCategory: "GameApplication",
      operatingSystem: "Web Browser",
      url: `${SITE_ORIGIN}/ccb`,
      inLanguage: "zh-CN",
      description: "基于 Bangumi 数据库的多人动漫角色竞猜游戏，支持逐属性线索排查、组队对战与战术 BP 规则。",
      featureList: [
        "基于百万级 Bangumi 数据库的动漫角色检索与竞猜",
        "登场年份、评分、性别、声优与标签的多维度线索反馈",
        "角色全局 BP 与标签全局 BP 深度战术模式",
        "模糊立绘渐进解锁提示系统",
        "自研增强版与原版 CCB 房间协议无缝互通",
      ],
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
