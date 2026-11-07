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

/** 站点标语本体：首页标题用它，不带句号。 */
export const SITE_SLOGAN = "1000万以内最好玩的小游戏网站";

/**
 * 分享标语：每个登记页面的 description 第一句都必须是它。
 * 社媒卡片正文由 og:description 渲染，抓取器普遍只展示前两行——最想让人看到的一句
 * 放在最前面，写在正文之后会被直接截掉。构建期断言与 SEO E2E 都以它为约束。
 */
export const SITE_TAGLINE = `${SITE_SLOGAN}。`;

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

/**
 * 三款游戏与首页的一句话介绍。description、静态外壳正文与结构化数据共用这几句：
 * 结构化数据必须和页面正文说同一件事，分开写迟早漂移。
 */
const HOME_SUMMARY =
  "BakaGame 是一间开给二次元朋友的游戏室：Who is Faker 谁是卧底比谁会装，Songuessr 听歌猜歌比谁耳朵灵，CEE 猜动漫角色比谁的番没白看。";
const FAKER_SUMMARY =
  "Who is Faker 是出题人现场写词的谁是卧底：谁都不知道自己拿的是平民词还是卧底词，描述和投票之后还要入夜，平民动刀，倒下的是自己。";
const SONG_SUMMARY =
  "Songuessr 是给番剧党和歌单党准备的听歌猜歌：听一段音乐，猜歌名，或者猜这首 OP、ED 出自哪部番。";
const CEE_SUMMARY =
  "CEE（二刺猿笑传之猜猜呗增强版）是多人猜动漫角色：全房猜同一个角色，从二十多万条 Bangumi 角色资料里，靠性别、登场年份、作品评分和标签一路排除。";
const ABOUTS_SUMMARY =
  "BakaGame 的关于项目页：开源致谢列出技术栈、参与开发的大模型和全部前端依赖的许可证，另有玩家更新日志、提交历史、隐私说明与用户条款。";

/** 三款游戏共用的结构化数据字段：都是房间制的网页游戏，不收费，界面为中文。 */
const GAME_ENTITY = {
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

export const PAGE_META: PageMeta[] = [
  {
    path: "/",
    title: `${SITE_NAME} - ${SITE_SLOGAN}`,
    lastmod: "2026-11-07",
    description: `${SITE_TAGLINE}${HOME_SUMMARY}开一间房，把房号发进群，人齐就开。`,
    image: `${SITE_ORIGIN}/og/logo.jpg`,
    keywords: [
      "BakaGame",
      "二次元小游戏",
      "二次元联机游戏",
      "朋友聚会玩什么",
      "群友一起玩的游戏",
      "宿舍联机小游戏",
      "谁是卧底",
      "听歌猜歌",
      "猜动漫角色",
      "二刺猿笑传之猜猜呗",
      "开源多人游戏",
    ],
    faq: [
      {
        q: "BakaGame 是什么网站？",
        a: "BakaGame 是一个开源的二次元多人游戏站，提供谁是卧底（Who is Faker）、听歌猜歌（Songuessr）和猜动漫角色（CEE）三款房间制游戏。朋友建一间房就能同桌开局，三款游戏考的分别是演技、耳朵和看番量。",
      },
      {
        q: "怎么和朋友一起开房？",
        a: "在任意一款游戏的大厅建房，再把房间链接或四位房号发给朋友，大家进同一间房就能开局。房主可以设密码、开关旁观，房内有文字聊天，掉线后重新连上会回到原来的座位。",
      },
      {
        q: "玩 BakaGame 要不要账号？",
        a: "普通房间进门只要一个昵称，账号只在少数场景才用得上。Songuessr 开局时房间里至少要有一人扫码登录网易云音乐或 QQ 音乐；CEE 排位赛和开启 BakaAntiCheat 的房间要求登录并使用 BakaGame 客户端。",
      },
      {
        q: "手机能玩吗？",
        a: "能，手机浏览器可以进同一间房，和电脑上的朋友一起玩，界面按触屏适配过。站内另外提供 Windows 和 Android 客户端。",
      },
      {
        q: "BakaGame 收费吗？",
        a: "不收费，用户条款写明本站按现状免费提供。代码也以 AGPL-3.0 许可证公开在 GitHub。",
      },
    ],
    shell: {
      h1: "BakaGame：二次元朋友局的游戏室，玩谁是卧底、听歌猜歌和猜动漫角色",
      paragraphs: [
        `${SITE_TAGLINE}${HOME_SUMMARY}`,
        "群友凑不齐一桌桌游，又不想只在群里发表情包的时候，这里有三张现成的桌子。",
      ],
      sections: [
        {
          heading: "三款游戏分别玩什么",
          paragraphs: [
            "Who is Faker（谁是卧底）：5 人起。出题人现场写词，玩家轮流描述、投票放逐，入夜后还能赌一把动刀。",
            "Songuessr（听歌猜歌）：一个人也能练。听片段猜歌名或番剧，曲库来自网易云音乐和 QQ 音乐，开局前房间里要有一人登录音乐账号。",
            "CEE（猜动漫角色）：2 人起。全房猜同一个角色，靠二十多万条 Bangumi 角色资料给出的线索一路排除，能组队、能 BP，也能进原版猜猜呗的房间。",
          ],
        },
        {
          heading: "怎么开一局",
          paragraphs: [
            "在游戏大厅建一间房，把房间链接或四位房号发给朋友。普通房间进门只要一个昵称，房主可以设密码、开关旁观。房内有文字聊天，掉线后重新连上会回到原来的座位。",
            "手机和电脑可以进同一间房，站内另有 Windows 和 Android 客户端。",
          ],
        },
        {
          heading: "关于这个项目",
          paragraphs: [
            "BakaGame 以 AGPL-3.0 许可证开源，服务端用 Bun 和 WebSocket 持有全部对局状态，客户端用 React 编写。更新日志、提交历史和依赖许可证都在关于项目页。",
          ],
        },
      ],
      links: [
        { href: "/whoisfaker", label: "Who is Faker 谁是卧底" },
        { href: "/songuessr", label: "Songuessr 听歌猜歌" },
        { href: "/cee", label: "CEE 猜动漫角色" },
        { href: "/abouts", label: "关于项目" },
        { href: "/llms.txt", label: "站点说明 llms.txt（写给 AI 助手和爬虫）" },
      ],
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SITE_NAME,
      url: `${SITE_ORIGIN}/`,
      inLanguage: "zh-CN",
      description: HOME_SUMMARY,
      // 三款游戏作为站点的组成部分列出：比把游戏名塞进站点别名更准确，
      // 否则 AI 搜索会把「二刺猿笑传之猜猜呗」这类名字当成整站的别称。
      hasPart: [
        { "@type": "VideoGame", name: "Who is Faker", url: `${SITE_ORIGIN}/whoisfaker` },
        { "@type": "VideoGame", name: "Songuessr", url: `${SITE_ORIGIN}/songuessr` },
        { "@type": "VideoGame", name: "CEE", url: `${SITE_ORIGIN}/cee` },
      ],
      // 组织实体 + sameAs 指向源码仓库：帮 AI 搜索把「BakaGame」这个名字与站点、
      // 代码仓库收敛成同一个实体——实体锚点越明确，站外提及时越容易被正确指认。
      publisher: {
        "@type": "Organization",
        name: SITE_NAME,
        url: `${SITE_ORIGIN}/`,
        logo: `${SITE_ORIGIN}/og/logo.jpg`,
        slogan: SITE_TAGLINE,
        sameAs: [REPOSITORY_URL],
      },
    },
  },
  {
    path: "/whoisfaker",
    title: `谁是卧底 Who is Faker - ${SITE_NAME}`,
    lastmod: "2026-11-07",
    description: `${SITE_TAGLINE}${FAKER_SUMMARY}5 人起开局，参战满 8 人可加白板和天使。`,
    image: `${SITE_ORIGIN}/og/Faker.jpg`,
    keywords: [
      "谁是卧底",
      "谁是卧底怎么玩",
      "谁是卧底多人联机",
      "谁是卧底白板规则",
      "谁是卧底出题",
      "Who is Faker",
      "WhoisFaker",
      "语言推理游戏",
      "朋友聚会游戏",
    ],
    faq: [
      {
        q: "谁是卧底怎么玩？",
        a: "谁是卧底是靠描述和投票找出异类的语言推理游戏：大多数人拿到同一个词，卧底拿到一个相近的词。在 Who is Faker 里，所有人轮流描述自己的词，再投票放逐一人；卧底全部出局则好人获胜，存活卧底追上存活好人则卧底获胜。",
      },
      {
        q: "Who is Faker 和普通的谁是卧底有什么不同？",
        a: "Who is Faker 最大的不同是夜晚：投票之后入夜，平民和卧底都可以选择动刀或不行动，卧底刀中的目标出局，平民动刀出局的是自己。玩家手里只有一个词，系统不说它属于哪边，所以敢不敢下手本身就是一次推理。词由不参战的出题人现场写，没有固定题库可背。",
      },
      {
        q: "Who is Faker 至少要几个人？",
        a: "Who is Faker 至少要 4 名参战玩家和 1 名出题人，也就是 5 个人。出题人可以由房内旁观者担任，卧底人数可以随参战人数调高。",
      },
      {
        q: "白板和天使是什么？",
        a: "白板和天使是参战满 8 人后才能开启的两种身份。白板没有词，只有出题人写的提示，每局有一次机会猜出平民词和卧底词，猜中直接获胜；天使同时拿到两个词，属于好人阵营。",
      },
      {
        q: "中途有人掉线怎么办？",
        a: "掉线的玩家重新连上后回到原来的座位，词和身份都还在。只有他正卡着流程时才由房主决定等待还是移除，已经完成本轮动作的掉线不影响倒计时。",
      },
    ],
    shell: {
      h1: "Who is Faker：出题人现场写词的谁是卧底",
      paragraphs: [
        `${FAKER_SUMMARY}词是临场想的，题库背不出来；出题人不参战，全程主持，还要裁定白板猜词里的错别字和同义词。`,
      ],
      sections: [
        {
          heading: "怎么玩一局",
          paragraphs: [
            "房主开局后指定一名出题人，出题人写下平民词和卧底词，系统默认随机发词。每轮所有人按随机顺序描述自己的词，再投票放逐一人；最高票相同就进入平票 PK，弃票也算有效提交。",
            "投票之后入夜，平民和卧底都可以选择动刀或不行动。天亮只公布谁出局，不公布是谁下的手，结算页才摊开全部行动。",
          ],
        },
        {
          heading: "怎么算赢",
          paragraphs: [
            "卧底全部出局，好人获胜；存活卧底人数追上存活好人，卧底获胜；白板猜中两个词，白板直接获胜。",
          ],
        },
        {
          heading: "为什么夜晚是这游戏的灵魂",
          paragraphs: [
            "玩家手里只有一个词，系统不告诉你它是平民词还是卧底词。卧底刀中的目标出局，平民动刀出局的是自己，所以下手之前得先判断自己到底站在哪边。自信的卧底和自信的平民，夜里的结局完全相反。",
          ],
        },
        {
          heading: "白板和天使",
          paragraphs: [
            "参战满 8 人后，房主可以开启白板和天使。白板没有词，只拿到出题人写的提示，每局有一次机会猜出平民词和卧底词，猜词时全房暂停围观，没有精确命中就交给出题人人工裁定。天使同时拿到两个词，属于好人阵营。",
          ],
        },
        {
          heading: "适合什么场合",
          paragraphs: [
            "适合 5 人以上的群友局、宿舍局和语音开黑。房间有文字聊天、观战和断线重连，也可以设密码，只放熟人进来互相背刺。",
          ],
        },
      ],
      links: [
        { href: "/", label: "BakaGame 首页" },
        { href: "/songuessr", label: "Songuessr 听歌猜歌" },
        { href: "/cee", label: "CEE 猜动漫角色" },
      ],
    },
    structuredData: {
      ...GAME_ENTITY,
      name: "Who is Faker（谁是卧底）",
      alternateName: ["WhoisFaker", "谁是卧底"],
      url: `${SITE_ORIGIN}/whoisfaker`,
      description: FAKER_SUMMARY,
      genre: ["派对游戏", "语言推理"],
      playMode: "https://schema.org/MultiPlayer",
      numberOfPlayers: { "@type": "QuantitativeValue", minValue: 5 },
      featureList: [
        "出题人现场写平民词与卧底词",
        "描述、投票与平票 PK",
        "夜晚动刀：卧底刀中目标出局，平民动刀自己出局",
        "参战满 8 人可开启白板与天使",
        "文字聊天、观战与断线重连",
      ],
    },
  },
  {
    path: "/songuessr",
    title: `听歌猜歌 Songuessr - ${SITE_NAME}`,
    lastmod: "2026-11-07",
    description: `${SITE_TAGLINE}${SONG_SUMMARY}听歌识曲猜错时，年份、热度、语种和共同标签都会告诉你偏到了哪里。曲库来自网易云音乐与 QQ 音乐，番剧资料来自 Bangumi。`,
    image: `${SITE_ORIGIN}/og/SongGuessr.jpg`,
    keywords: [
      "Songuessr",
      "听歌猜歌",
      "听歌识曲",
      "听歌识番",
      "猜歌游戏",
      "多人猜歌",
      "猜番剧",
      "动漫歌曲竞猜",
      "番剧 OP 猜歌",
      "网易云歌单猜歌",
      "QQ音乐歌单猜歌",
    ],
    faq: [
      {
        q: "Songuessr 怎么玩？",
        a: "Songuessr 是听片段猜答案的音乐竞猜游戏：每回合播放一段音乐，玩家搜索并提交歌名或番剧名。听歌识曲猜错时会看到发行年份早晚、热度高低、语种是否一致和共同标签，用来缩小范围。",
      },
      {
        q: "听歌识曲和听歌识番有什么区别？",
        a: "听歌识曲要猜出这首歌本身，听歌识番要猜出这首歌所属的番剧。题型由房主在房间设置里选择，听歌识番还可以按 OP、ED、插曲、角色歌、OST 等曲目类型筛选。",
      },
      {
        q: "猜歌要登录音乐账号吗？",
        a: "要，开局前房间里至少要有一名玩家扫码登录网易云音乐或 QQ 音乐账号，单人模式也一样。其他玩家只要昵称就能进房。",
      },
      {
        q: "可以用自己的歌单出题吗？",
        a: "可以，自动出题时能指定一张网易云音乐或 QQ 音乐歌单，也能按歌手和热度门槛筛选。手动出题时由出题人搜歌，还可以自己截取片段。",
      },
      {
        q: "一个人能玩 Songuessr 吗？",
        a: "能，单人模式由系统自动出题，不用等人。多人房至少需要两名玩家，还可以分成最多 8 支队伍。",
      },
    ],
    shell: {
      h1: "Songuessr：听歌识曲与听歌识番，多人抢答也能一个人练",
      paragraphs: [`${SONG_SUMMARY}歌单党比谁的耳朵更毒，番剧党比谁的前奏记得更牢。`],
      sections: [
        {
          heading: "两种题型",
          paragraphs: [
            "听歌识曲要猜出歌曲本身，猜错时会看到发行年份早了还是晚了、热度高了还是低了、语种是否一致，以及和答案共有的标签。",
            "听歌识番要猜出这首歌所属的番剧，番剧资料来自 Bangumi，题目可以按 OP、ED、插曲、角色歌、OST 等曲目类型筛选。",
          ],
        },
        {
          heading: "怎么出题",
          paragraphs: [
            "手动出题时，出题人搜索网易云音乐或 QQ 音乐的歌曲并截取片段；房主也可以关掉自选片段，改由服务端随机截取。",
            "自动出题时，听歌识曲按歌单、歌手和热度门槛抽题，听歌识番按年份、排行范围、歌曲热度和曲目类型抽题。",
          ],
        },
        {
          heading: "房间能调什么",
          paragraphs: [
            "房间可以显示逐字歌词，也可以完全盲听；每回合的猜测次数、猜题时长和血战规则都由房主设定。",
          ],
        },
        {
          heading: "开局需要什么",
          paragraphs: [
            "开局前房间里至少要有一名玩家扫码登录网易云音乐或 QQ 音乐账号，其他人只要昵称就能进房。多人房至少两名玩家，单人模式由系统自动出题。",
          ],
        },
        {
          heading: "适合什么场合",
          paragraphs: [
            "适合歌单党互相出题，适合番剧群比谁听得出前奏，也适合一个人把补过的番再听一遍，确认自己是真的看过。",
          ],
        },
      ],
      links: [
        { href: "/", label: "BakaGame 首页" },
        { href: "/whoisfaker", label: "Who is Faker 谁是卧底" },
        { href: "/cee", label: "CEE 猜动漫角色" },
      ],
    },
    structuredData: {
      ...GAME_ENTITY,
      name: "Songuessr",
      alternateName: ["SonGuessr", "听歌猜歌", "听歌识曲", "听歌识番"],
      url: `${SITE_ORIGIN}/songuessr`,
      description: SONG_SUMMARY,
      genre: ["音乐竞猜", "派对游戏"],
      playMode: ["https://schema.org/SinglePlayer", "https://schema.org/MultiPlayer"],
      numberOfPlayers: { "@type": "QuantitativeValue", minValue: 1 },
      featureList: [
        "听歌识曲与听歌识番两种题型",
        "曲库来自网易云音乐与 QQ 音乐，番剧资料来自 Bangumi",
        "手动点歌出题，或按歌单、歌手、年份与曲目类型自动抽题",
        "逐字歌词与盲听可选",
        "单人模式与最多 8 支队伍的多人房",
      ],
    },
  },
  {
    path: "/cee",
    title: `猜动漫角色 CEE - ${SITE_NAME}`,
    lastmod: "2026-11-07",
    description: `${SITE_TAGLINE}${CEE_SUMMARY}能组队、能 BP、能进原版房间，专治自称看过很多番的人。`,
    image: `${SITE_ORIGIN}/og/CEE.jpg`,
    keywords: [
      "CEE",
      "二刺猿笑传之猜猜呗",
      "二刺猿笑传之猜猜呗增强版",
      "猜动漫角色",
      "多人猜动漫角色",
      "二次元角色猜谜",
      "动漫 Wordle",
      "Bangumi 角色",
      "角色 BP",
    ],
    faq: [
      {
        q: "猜动漫角色怎么玩？",
        a: "CEE 是多人猜动漫角色游戏：全房玩家猜同一个隐藏角色，每提交一个角色，系统就对比性别、人气、作品评分、出演作品数、最早和最晚登场年份，并标出共同作品和命中的标签。玩家靠这些线索一步步缩小范围，直到猜中。",
      },
      {
        q: "CEE 的角色数据从哪里来？",
        a: "CEE 的角色资料来自 Bangumi（番组计划），数据集收录二十多万条角色条目。对局从房间设置限定的作品范围里出题。",
      },
      {
        q: "角色 BP 和标签 BP 是什么？",
        a: "角色 BP 和标签 BP 是 CEE 的两条可选房规。角色全局 BP 开启后，已经被猜过的角色全房不能再猜；标签全局 BP 开启后，已被对手命中的标签对其他队伍隐藏，比的是谁先拿到信息。",
      },
      {
        q: "CEE 能组队吗？",
        a: "能，CEE 最多支持 8 支队伍同台，同队共用尝试记录、次数和行动计时。",
      },
      {
        q: "能和玩原版猜猜呗的朋友一起吗？",
        a: "能，CEE 大厅可以创建或加入原版服务器的房间，和用原版客户端的朋友同房。这类房间的计时和积分由原版服务器决定，双方资料版本不同时，反馈可能有出入。",
      },
    ],
    shell: {
      h1: "CEE：二刺猿笑传之猜猜呗增强版，多人猜动漫角色",
      paragraphs: [
        `${CEE_SUMMARY}玩法出自原版猜猜呗，增强版在房间、组队和规则上加了不少东西，也保留了和原版同房的能力。`,
      ],
      sections: [
        {
          heading: "怎么玩一局",
          paragraphs: [
            "开局后由系统随机选定答案，或者由房主指定的出题人来选，所有人猜同一个角色。每提交一个角色，都会看到性别、人气、作品评分、出演作品数、最早和最晚登场年份的比较结果，以及共同作品和标签命中情况。",
          ],
        },
        {
          heading: "三种结算方式",
          paragraphs: [
            "普通模式首位猜中即结算；同步模式等当轮所有人提交后一起判定；血战模式一直打到全部参与者结束。",
          ],
        },
        {
          heading: "组队与 BP",
          paragraphs: [
            "最多 8 支队伍同台，同队共用尝试记录、次数和行动计时。角色全局 BP 开启后，猜过的角色全房不能再猜，冷门知识储备开始值钱；标签全局 BP 开启后，已被对手命中的标签对其他队伍隐藏，比的是信息差。",
          ],
        },
        {
          heading: "卡住了怎么办",
          paragraphs: [
            "房主可以设置提示：猜到一定次数后解锁文字线索，或者解锁模糊立绘。未解锁时不会下发原图。",
          ],
        },
        {
          heading: "和原版猜猜呗的关系",
          paragraphs: [
            "CEE 大厅既能开增强版房间，也能创建或加入原版服务器的房间，和用原版客户端的朋友同房。这类房间的计时和积分由原版服务器决定，双方资料版本不同时，反馈可能有出入。",
          ],
        },
        {
          heading: "反作弊房",
          paragraphs: [
            "房主建增强版房间时可以开启 BakaAntiCheat，该房间只接受已登录的 BakaGame 桌面或移动客户端玩家；这个开关默认关闭，不影响普通网页房间。",
          ],
        },
      ],
      links: [
        { href: "/", label: "BakaGame 首页" },
        { href: "/whoisfaker", label: "Who is Faker 谁是卧底" },
        { href: "/songuessr", label: "Songuessr 听歌猜歌" },
      ],
    },
    structuredData: {
      ...GAME_ENTITY,
      name: "CEE（二刺猿笑传之猜猜呗增强版）",
      alternateName: ["CEE", "二刺猿笑传之猜猜呗增强版", "猜动漫角色"],
      url: `${SITE_ORIGIN}/cee`,
      description: CEE_SUMMARY,
      genre: ["动漫知识竞猜", "派对游戏"],
      playMode: "https://schema.org/MultiPlayer",
      numberOfPlayers: { "@type": "QuantitativeValue", minValue: 2 },
      featureList: [
        "二十多万条 Bangumi 角色资料",
        "性别、人气、评分、登场年份、共同作品与标签的逐项反馈",
        "最多 8 支队伍组队对抗",
        "角色全局 BP 与标签全局 BP",
        "文字线索与模糊立绘提示",
        "可创建或加入原版服务器的房间",
      ],
    },
  },
  {
    path: "/abouts",
    title: `关于 ${SITE_NAME}`,
    lastmod: "2026-11-07",
    description: `${SITE_TAGLINE}${ABOUTS_SUMMARY}`,
    image: `${SITE_ORIGIN}/og/logo.jpg`,
    keywords: [
      "BakaGame 开源",
      "BakaGame 更新日志",
      "BakaGame 提交历史",
      "BakaGame 隐私说明",
      "BakaGame 用户条款",
      "开源致谢",
      "依赖许可证",
    ],
    faq: [
      {
        q: "BakaGame 的关于项目页有什么？",
        a: "关于项目页有五个标签：开源致谢、更新日志、提交历史、隐私说明和用户条款。开源致谢里列出核心技术栈、参与开发的大模型，以及前端全部 npm 依赖的版本和许可证。",
      },
      {
        q: "怎么查看某个依赖的许可证原文？",
        a: "在依赖清单里点开任意条目，右侧抽屉会按需加载该包自带的 LICENSE、COPYING 或 NOTICE 原文。清单可以按包名搜索，也可以按 License 类型筛选。",
      },
      {
        q: "依赖清单是手写的吗？",
        a: "不是，依赖清单在每次构建时从当前安装的依赖生成，版本和许可证与当次发布的产物一致。",
      },
      {
        q: "大模型署名是怎么算的？",
        a: "只有实际改动过项目文件的模型才会署名，做了规划且计划被实行的规划模型同样计入。只参与讨论、咨询或评审的模型不计入。",
      },
    ],
    shell: {
      h1: "关于 BakaGame：开源致谢、更新日志、提交历史与隐私条款",
      paragraphs: [
        ABOUTS_SUMMARY,
        "依赖清单在构建期生成，可以按包名搜索、按 License 类型筛选，每个包的许可证原文按需加载。想看这周又修了什么，更新日志和提交历史都在同一页。",
      ],
      links: [
        { href: "/", label: "BakaGame 首页" },
        { href: "/whoisfaker", label: "Who is Faker 谁是卧底" },
        { href: "/songuessr", label: "Songuessr 听歌猜歌" },
        { href: "/cee", label: "CEE 猜动漫角色" },
        { href: "/abouts?tab=privacy", label: "隐私说明" },
        { href: "/abouts?tab=terms", label: "用户条款" },
      ],
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "AboutPage",
      name: "关于 BakaGame",
      url: `${SITE_ORIGIN}/abouts`,
      inLanguage: "zh-CN",
      description: ABOUTS_SUMMARY,
      isPartOf: {
        "@type": "WebSite",
        name: SITE_NAME,
        url: `${SITE_ORIGIN}/`,
      },
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
