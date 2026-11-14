import {
  GAME_ENTITY,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_PAGE_ENTRIES,
  SITE_TAGLINE,
  SONG_SUMMARY,
  type PageMeta,
} from "./Shared.ts";

export const SONG_PAGE_META: PageMeta = {
  ...SITE_PAGE_ENTRIES.song,
  title: `听歌猜歌 Songuessr：听歌识曲与听歌识番 - ${SITE_NAME}`,
  oneLiner: "听歌识曲，也听歌识番",
  lastmod: "2026-11-14",
  description: `${SITE_TAGLINE}Songuessr 听歌猜歌：听一段音乐猜歌名，或猜 OP、ED 出自哪部番。能和朋友比，也能一个人练，还能用自己的歌单出题。`,
  image: `${SITE_ORIGIN}/og/og-song.jpg`,
  imageAlt: "Songuessr 分享卡片：游戏图标与听歌猜歌字样",
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
};
