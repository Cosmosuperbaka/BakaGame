import {
  FAKER_SUMMARY,
  GAME_ENTITY,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_PAGE_ENTRIES,
  SITE_TAGLINE,
  type PageMeta,
} from "./Shared.ts";

export const FAKER_PAGE_META: PageMeta = {
  ...SITE_PAGE_ENTRIES.faker,
  title: `谁是卧底 Who is Faker - ${SITE_NAME}`,
  oneLiner: "出题人现场写词的谁是卧底",
  lastmod: "2026-11-14",
  description: `${SITE_TAGLINE}Who is Faker 是出题人现场写词的谁是卧底，5 人起。投票后入夜：平民动刀，倒下的是自己。满 8 人可加白板和天使。`,
  image: `${SITE_ORIGIN}/og/og-faker.jpg`,
  imageAlt: "Who is Faker 分享卡片：游戏图标与谁是卧底字样",
  keywords: [
    "谁是卧底",
    "谁是卧底怎么玩",
    "谁是卧底多人联机",
    "谁是卧底白板规则",
    "谁是卧底出题",
    "Who is Faker",
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
};
