import {
  DEFAULT_OG_IMAGE_ALT,
  HOME_SUMMARY,
  ORGANIZATION_ID,
  REPOSITORY_URL,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_PAGE_ENTRIES,
  SITE_SLOGAN,
  SITE_TAGLINE,
  type PageMeta,
} from "./Shared.ts";

export const HOME_PAGE_META: PageMeta = {
  ...SITE_PAGE_ENTRIES.home,
  title: `${SITE_NAME} - ${SITE_SLOGAN}`,
  oneLiner: "谁是卧底、听歌猜歌、猜动漫角色",
  lastmod: "2026-11-14",
  description: `${SITE_TAGLINE}BakaGame 是开给二次元朋友的游戏室：谁是卧底、听歌猜歌、猜动漫角色。开一间房，把房号发进群，手机电脑都能进，人齐就开。`,
  image: `${SITE_ORIGIN}/og/og-home.jpg`,
  imageAlt: DEFAULT_OG_IMAGE_ALT,
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
    h1: "BakaGame：二次元朋友的游戏室",
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
    "@id": `${SITE_ORIGIN}/#website`,
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
    // 带 @id 的组织是全站唯一的组织节点；logo 用构建期生成的方形图标，搜索引擎要求方形。
    publisher: {
      "@type": "Organization",
      "@id": ORGANIZATION_ID,
      name: SITE_NAME,
      url: `${SITE_ORIGIN}/`,
      logo: {
        "@type": "ImageObject",
        url: `${SITE_ORIGIN}/favicon-512.png`,
        width: 512,
        height: 512,
      },
      sameAs: [REPOSITORY_URL],
    },
  },
};
