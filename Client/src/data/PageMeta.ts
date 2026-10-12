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
  /**
   * 站点地图的 lastmod（YYYY-MM-DD）。只在页面文案或结构有显著变更时更新：
   * 每次构建都刷新会让搜索引擎判定该字段不可信，进而整体忽略它（不写比写错好）。
   */
  lastmod?: string;
  /** meta description 与 og:description */
  description: string;
  /**
   * 社交媒体分享图（og:image）。本站图统一用 `${SITE_ORIGIN}/og/<名>.jpg`：
   * 全站图片管线只产 webp，而部分分享抓取器（QQ 实测）不认 webp，卡片显示不出图；
   * 构建期 `seo-artifacts` 插件会从 `public/assets/<名>.*` 的同名源图转出 jpg。
   * 也接受外链绝对地址（原样使用，不转制）。
   */
  image?: string;
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

export const PAGE_META: PageMeta[] = [
  {
    path: "/",
    lastmod: "2026-10-13",
    description:
      "BakaGame是一个二刺猿派对小游戏合集站，主要玩法包括：WhoisFaker谁是卧底、Songuessr听歌识曲/听歌识番、二刺猿笑传之猜猜呗增强版。这绝对是1000万以内你能找到体验最好的派对小游戏网站。",
    image: `${SITE_ORIGIN}/og/logo.jpg`,
    keywords: [
      "BakaGame",
      "派对游戏",
      "联机对战",
      "谁是卧底",
      "听歌识曲",
      "听歌识番",
      "猜动漫角色",
      "二次元小游戏",
      "聚会开黑",
      "Wordle",
      "二刺猿",
      "在线派对游戏",
      "免费网页游戏",
    ],
    faq: [
      {
        q: "BakaGame 是什么？",
        a: "一个二刺猿派对小游戏合集站，包含在线谁是卧底（WhoisFaker）、听歌识曲/听歌识番（Songuessr）和二刺猿笑传之猜猜呗增强版（CCB）三个玩法，丢个链接就能联机开黑。",
      },
      {
        q: "玩 BakaGame 需要注册或下载吗？",
        a: "不需要。免下载免注册，浏览器打开就能玩，所有模式都支持自由开房。",
      },
      {
        q: "怎么邀请朋友一起玩？",
        a: "创建房间后把房间链接发给朋友，打开即可加入；房间支持实时聊天，掉线也能秒级重连。",
      },
      {
        q: "手机上能玩吗？",
        a: "支持。移动端浏览器直接打开就能玩，和朋友开黑不用装 App。",
      },
    ],
    shell: {
      h1: "BakaGame——二刺猿派对小游戏合集站",
      paragraphs: [
        "BakaGame 专注于轻快硬核的多人联机派对游戏。集合了玩法优化过的谁是卧底、联动网易云、QQ音乐与 Bangumi 的歌曲及番剧竞猜（Songuessr）、以及基于数十万角色库线索收敛的 CCB 猜动漫角色。丢个链接即可加入房间，支持实时聊天与断线秒级重连。",
        "不管是宿舍开黑、群友摸鱼还是聚会破冰，想玩随时能来一局：在 WhoisFaker 里拼演技，在 Songuessr 里抢答歌曲和番剧，在二刺猿笑传之猜猜呗增强版里一步步锁定目标角色。所有模式支持自由开房，免下载免注册，有浏览器就能玩。",
      ],
      links: [
        { href: "/whoisfaker", label: "WhoisFaker入口" },
        { href: "/songuessr", label: "Songuessr入口" },
        { href: "/ccb", label: "二刺猿笑传之猜猜呗增强版入口" },
      ],
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "BakaGame",
      alternateName: ["二刺猿笑传之猜猜呗", "Who is Faker", "Songuessr", "CCB", "CEE", "二刺猿笑传之猜猜呗增强版"],
      url: `${SITE_ORIGIN}/`,
      inLanguage: "zh-CN",
      description:
        "一个二刺猿派对小游戏合集站，主要玩法包括：WhoisFaker谁是卧底、Songuessr听歌识曲/听歌识番、二刺猿笑传之猜猜呗增强版",
      // 组织实体 + sameAs 指向源码仓库：帮 AI 搜索把「BakaGame」这个名字与站点、
      // 代码仓库收敛成同一个实体——实体锚点越明确，站外提及时越容易被正确指认。
      publisher: {
        "@type": "Organization",
        name: "BakaGame",
        url: `${SITE_ORIGIN}/`,
        logo: `${SITE_ORIGIN}/og/logo.jpg`,
        sameAs: [REPOSITORY_URL],
      },
    },
  },
  {
    path: "/whoisfaker",
    lastmod: "2026-10-13",
    description:
      "在线版谁是卧底（WhoisFaker）：4~16 人实时联机的语言推理派对游戏，自由出题、全员投票、平票加赛与白板、天使机制全都有，丢个链接即刻开局。",
    image: `${SITE_ORIGIN}/og/Faker.jpg`,
    keywords: [
      "谁是卧底",
      "在线版谁是卧底",
      "WhoisFaker",
      "Who is Faker",
      "文字推理",
      "语言推理",
      "聚会桌游",
      "白板猜词",
      "天使护盾",
      "心理博弈",
    ],
    faq: [
      {
        q: "在线谁是卧底怎么玩？",
        a: "每人拿到自己的词，其中卧底拿到的词与其他人相近；轮流描述自己的词，再一起投票把卧底找出来。",
      },
      {
        q: "支持多少个人一起玩？",
        a: "4~16 人同房联机，凑齐 4 人即可开局。",
      },
      {
        q: "「白板」和「天使」是什么机制？",
        a: "两个进阶机制：8 人局可开「白板」，无词上阵、只有词性提示，猜对词语即可背水反杀；「天使」双词双阵营，自选阵营并带一次性护盾。",
      },
      {
        q: "中途有人掉线怎么办？",
        a: "房间支持断线重连，重连后席位与身份完整保留，不影响这局继续玩。",
      },
    ],
    shell: {
      h1: "WhoisFaker——在线版谁是卧底",
      paragraphs: [
        "在线版谁是卧底，经典的语言推理派对游戏。支持 4~16 人同房博弈：出题人自由出题，系统自动分发平民、卧底与特殊身份，还支持平票加赛、局外观战与断线重连，重连后席位与身份完整保留。",
        "进阶机制同样齐备：8 人局可开「白板」——无词上阵、只有词性提示，猜对词语即可背水反杀；「天使」双词双阵营，自选阵营并带一次性护盾；死亡身份即时翻牌也可开关。拼口才、拼逻辑，找出藏在身边的卧底。",
      ],
      links: [
        { href: "/", label: "返回主页" },
        { href: "/songuessr", label: "Songuessr入口" },
        { href: "/ccb", label: "二刺猿笑传之猜猜呗增强版入口" },
      ],
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "WhoisFaker 在线版谁是卧底",
      alternateName: ["Who is Faker"],
      applicationCategory: "GameApplication",
      operatingSystem: "Web Browser",
      url: `${SITE_ORIGIN}/whoisfaker`,
      inLanguage: "zh-CN",
      description: "支持 4~16 人实时联机的在线版谁是卧底（WhoisFaker），包含自由出题、白板、天使、平票加赛与断线重连等机制。",
      featureList: [
        "4~16 人实时联机对局",
        "出题人自由出题与系统分发身份",
        "8 人局「白板」猜词背水反杀",
        "「天使」双词阵营与一次性护盾",
        "平票 PK 加赛、局外观战与断线重连",
      ],
      offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
    },
  },
  {
    path: "/songuessr",
    lastmod: "2026-10-13",
    description:
      "听歌猜歌，也能听歌识番！Songuessr 联动网易云、QQ音乐与 Bangumi：猜歌名或猜番剧，逐字歌词随曲点亮，年份、热度、标签线索逐步收窄，单人练习与多人抢答都支持。",
    image: `${SITE_ORIGIN}/og/SongGuessr.jpg`,
    keywords: [
      "Songuessr",
      "听歌猜歌",
      "听歌识曲",
      "听歌识番",
      "猜番剧",
      "动漫音乐竞猜",
      "动漫OP ED",
      "网易云音乐猜歌",
      "Bangumi番剧",
      "逐字歌词",
      "ACG音乐",
    ],
    faq: [
      {
        q: "Songuessr 怎么玩？",
        a: "播放歌曲片段，猜歌名或猜它出自哪部番剧；既能轮流手动点歌出题，也能按年份与热度智能抽题。",
      },
      {
        q: "歌曲和番剧数据来自哪里？",
        a: "联动网易云、QQ音乐曲库与 Bangumi 番剧资料库，覆盖动漫 OP、ED、插曲、角色歌、OST 与流行金曲。",
      },
      {
        q: "「猜歌名」和「猜番剧」有什么区别？",
        a: "猜歌名是听片段猜歌曲；猜番剧是猜这首歌出自哪部番剧，还能结合逐字歌词找线索，两种模式随时切换。",
      },
      {
        q: "猜错了有什么提示吗？",
        a: "有。提交答案后按 Wordle 式反馈：年代偏差、热度区间、语种与共同标签，一步步把范围收窄到唯一答案。",
      },
    ],
    shell: {
      h1: "Songuessr——音乐与动漫番剧竞猜",
      paragraphs: [
        "听前奏、看歌词、猜番剧：Songuessr 联动网易云、QQ音乐曲库与 Bangumi 番剧资料库，覆盖动漫 OP、ED、插曲、角色歌、OST 与流行金曲。既能轮流手动点歌出题，也能按年份与热度智能抽题；猜歌名、猜番剧两种模式随时切换。",
        "内置 Apple Music 风格逐字歌词动效，也可以完全盲听；音频连续切片、平滑渐入渐出。提交答案后按 Wordle 式反馈提示：年代偏差、热度区间、语种与共同标签，一步步把范围收窄到唯一答案。",
      ],
      links: [
        { href: "/", label: "返回主页" },
        { href: "/whoisfaker", label: "WhoisFaker入口" },
        { href: "/ccb", label: "二刺猿笑传之猜猜呗增强版入口" },
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
      description: "联动网易云、QQ音乐与 Bangumi 的在线竞猜游戏：猜歌名与猜番剧双赛道，逐字歌词播放，年份、热度与标签多维线索逐步收窄。",
      featureList: [
        "「猜歌名」与「猜番剧」双赛道竞猜",
        "联动网易云、QQ音乐与 Bangumi 曲库",
        "Apple Music 风格逐字渐变歌词播放器",
        "年份、热度、语种与标签偏差的 Wordle 式反馈",
        "单人练习与多人抢答模式",
      ],
      offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
    },
  },
  {
    path: "/ccb",
    lastmod: "2026-10-13",
    description:
      "多人一起猜动漫角色！CCB（二刺猿笑传之猜猜呗增强版）基于数十万条 Bangumi 角色资料，从性别、年代、评分、声优到标签逐层排除，支持组队对抗、角色 BP 与原版服务器互通。",
    image: `${SITE_ORIGIN}/og/CCB.jpg`,
    keywords: [
      "CCB",
      "二刺猿笑传之猜猜呗",
      "二刺猿笑传之猜猜呗增强版",
      "猜动漫角色",
      "在线猜动漫角色",
      "Bangumi",
      "动漫知识竞猜",
      "角色BP",
      "动漫Wordle",
    ],
    faq: [
      {
        q: "在线猜动漫角色怎么玩？",
        a: "所有人围绕同一个目标角色提交猜测，系统实时反馈性别、登场年代、作品评分、出演作品重合度与角色标签等维度，逐步收敛到答案。",
      },
      {
        q: "角色数据来自哪里？",
        a: "基于数十万条 Bangumi 角色资料库。",
      },
      {
        q: "有哪些游戏模式？",
        a: "支持个人混战与组队对抗、轮流出题、模糊立绘渐进提示，还有「角色全局 BP」「标签全局 BP」两套战术规则。",
      },
      {
        q: "能和玩原版 CCB 的朋友联机吗？",
        a: "可以。增强版房间兼容原版 CCB 联机协议，支持跨端同台。",
      },
    ],
    shell: {
      h1: "CCB——在线猜动漫角色（二刺猿笑传之猜猜呗增强版）",
      paragraphs: [
        "在线猜动漫角色，基于数十万条 Bangumi 角色资料库：所有人一同竞猜同一个目标角色，每次提交都会实时反馈性别、登场年代、作品评分、出演作品重合度与角色标签，一步步逼近真相。",
        "支持个人混战与组队对抗、轮流出题、模糊立绘渐进提示，以及「角色全局 BP」「标签全局 BP」两套战术规则；增强版房间全面兼容原版 CCB 联机协议，可以和老玩家跨端同台。",
      ],
      links: [
        { href: "/", label: "返回主页" },
        { href: "/whoisfaker", label: "WhoisFaker入口" },
        { href: "/songuessr", label: "Songuessr入口" },
      ],
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "CCB 猜动漫角色",
      alternateName: ["二刺猿笑传之猜猜呗", "二刺猿笑传之猜猜呗增强版"],
      applicationCategory: "GameApplication",
      operatingSystem: "Web Browser",
      url: `${SITE_ORIGIN}/ccb`,
      inLanguage: "zh-CN",
      description: "基于数十万条 Bangumi 角色资料的多人猜动漫角色游戏，支持逐属性线索排查、组队对战与角色/标签全局 BP。",
      featureList: [
        "基于数十万条 Bangumi 角色资料的检索与竞猜",
        "性别、登场年代、评分、声优与标签的多维线索反馈",
        "角色全局 BP 与标签全局 BP 战术模式",
        "模糊立绘渐进解锁提示",
        "增强版与原版 CCB 房间协议互通",
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

/**
 * 由 FAQ 条目派生 FAQPage 结构化数据。
 * 构建期外壳与运行时 `Seo` 共用本函数：同一份问答在两处的 JSON-LD 结构不会漂移。
 * 无问答时返回 null，调用方据此不注入（或移除）对应脚本。
 */
export function buildFaqStructuredData(faq: PageFaqItem[] | undefined): Record<string, unknown> | null {
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
