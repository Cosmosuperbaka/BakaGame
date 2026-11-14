import {
  CEE_SUMMARY,
  GAME_ENTITY,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_PAGE_ENTRIES,
  SITE_TAGLINE,
  type PageMeta,
} from "./Shared.ts";

export const CEE_PAGE_META: PageMeta = {
  ...SITE_PAGE_ENTRIES.cee,
  title: `猜动漫角色 CEE（猜猜呗增强版） - ${SITE_NAME}`,
  oneLiner: "二刺猿笑传之猜猜呗增强版",
  lastmod: "2026-11-14",
  description: `${SITE_TAGLINE}CEE 是二刺猿笑传之猜猜呗增强版：全房一起猜动漫角色，靠性别、登场年份和标签一路排除。能组队、能 BP，也能进原版房间。`,
  image: `${SITE_ORIGIN}/og/og-cee.jpg`,
  imageAlt: "CEE 分享卡片：游戏图标与猜动漫角色字样",
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
};
