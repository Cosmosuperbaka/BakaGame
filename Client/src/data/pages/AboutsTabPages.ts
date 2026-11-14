import {
  DEFAULT_OG_IMAGE_ALT,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_PAGE_ENTRIES,
  SITE_TAGLINE,
  type PageMeta,
  type SitePageEntry,
} from "./Shared.ts";

/**
 * 关于页里三个各有独立地址的标签：更新日志、隐私说明、用户条款。
 * 正文仍只在关于页的标签里渲染一份，这里只是它们各自的标题、描述与爬虫外壳。
 */

/** 三页的公共骨架：分享图沿用站点卡片，结构化数据是挂在站点下的一张普通网页。 */
function aboutsTabPage(
  entry: SitePageEntry,
  meta: Pick<PageMeta, "title" | "description" | "keywords" | "faq" | "shell"> & {
    summary: string;
  }
): PageMeta {
  const { summary, ...rest } = meta;
  return {
    ...entry,
    ...rest,
    lastmod: "2026-11-15",
    image: `${SITE_ORIGIN}/og/og-home.jpg`,
    imageAlt: DEFAULT_OG_IMAGE_ALT,
    structuredData: {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: `${SITE_NAME} ${entry.shortTitle}`,
      url: `${SITE_ORIGIN}${entry.path}`,
      inLanguage: "zh-CN",
      description: summary,
      isPartOf: {
        "@type": "WebSite",
        name: SITE_NAME,
        url: `${SITE_ORIGIN}/`,
      },
    },
  };
}

/** 外壳链接：三页互相指着，再加关于页本身与首页。 */
const ABOUTS_LINKS = [
  { href: "/", label: "BakaGame 首页" },
  { href: SITE_PAGE_ENTRIES.abouts.path, label: "关于项目" },
  { href: SITE_PAGE_ENTRIES.changelog.path, label: "更新日志" },
  { href: SITE_PAGE_ENTRIES.privacy.path, label: "隐私说明" },
  { href: SITE_PAGE_ENTRIES.terms.path, label: "用户条款" },
];

const linksExcept = (path: string) => ABOUTS_LINKS.filter((link) => link.href !== path);

const CHANGELOG_SUMMARY =
  "BakaGame 的玩家更新日志：每个版本新增了什么、修了什么，按版本号从新到旧排列。";

export const CHANGELOG_PAGE_META = aboutsTabPage(SITE_PAGE_ENTRIES.changelog, {
  title: `更新日志 - ${SITE_NAME}`,
  description: `${SITE_TAGLINE}${CHANGELOG_SUMMARY}`,
  summary: CHANGELOG_SUMMARY,
  keywords: ["BakaGame 更新日志", "BakaGame 版本", "BakaGame 新功能"],
  faq: [
    {
      q: "在哪里看 BakaGame 每个版本改了什么？",
      a: "更新日志按版本列出每次面向玩家的新增与修复，首页底部的版本号也直接链到这一页。想看更细的代码改动，关于项目页的提交历史标签列出了最近的提交。",
    },
  ],
  shell: {
    h1: "BakaGame 更新日志",
    paragraphs: [
      CHANGELOG_SUMMARY,
      "日志只写玩家能感受到的变化：新玩法、新设置、修掉的问题。代码层面的改动在关于项目页的提交历史里。",
    ],
    links: linksExcept(SITE_PAGE_ENTRIES.changelog.path),
  },
});

const PRIVACY_SUMMARY =
  "BakaGame 的隐私说明：会收集哪些信息、用来做什么、保留多久、会经过哪些第三方服务，以及怎样申请查询或删除。";

export const PRIVACY_PAGE_META = aboutsTabPage(SITE_PAGE_ENTRIES.privacy, {
  title: `隐私说明 - ${SITE_NAME}`,
  description: `${SITE_TAGLINE}${PRIVACY_SUMMARY}`,
  summary: PRIVACY_SUMMARY,
  keywords: ["BakaGame 隐私说明", "BakaGame 隐私政策", "BakaGame 数据删除"],
  faq: [
    {
      q: "玩 BakaGame 需要注册吗？",
      a: "不需要。普通房间进门只要一个昵称，游客状态下收集的信息更少。账号以 QQ 号登录，云同步、在站内看反馈回复和排位赛这些功能需要登录。",
    },
    {
      q: "怎么删除我在 BakaGame 的账号数据？",
      a: "目前没有自助导出或删除的入口。通过站内反馈说明需求，运营者核实账号归属后手动处理。",
    },
  ],
  shell: {
    h1: "BakaGame 隐私说明",
    paragraphs: [
      PRIVACY_SUMMARY,
      "每一项信息都写明了来源、用途和保留期限，包括账号资料、对局记录、站内反馈、访问统计、错误监控与音乐平台凭据。",
    ],
    links: linksExcept(SITE_PAGE_ENTRIES.privacy.path),
  },
});

const TERMS_SUMMARY =
  "BakaGame 的用户条款：服务说明、账号与第三方凭据、使用规范、用户内容，以及服务变更与免责。";

export const TERMS_PAGE_META = aboutsTabPage(SITE_PAGE_ENTRIES.terms, {
  title: `用户条款 - ${SITE_NAME}`,
  description: `${SITE_TAGLINE}${TERMS_SUMMARY}`,
  summary: TERMS_SUMMARY,
  keywords: ["BakaGame 用户条款", "BakaGame 服务条款", "BakaGame 使用规范"],
  faq: [
    {
      q: "用自己的音乐账号玩听歌猜歌有什么风险？",
      a: "听歌猜歌会以你配置的网易云音乐或 QQ 音乐账号请求平台接口，平台可能对账号采取封禁、限流等处置，这部分风险由玩家自行承担。",
    },
    {
      q: "BakaGame 和 Bangumi、网易云音乐有关系吗？",
      a: "没有。BakaGame 是爱好者作品，与游戏涉及作品的版权方以及 Bangumi、网易云音乐、QQ 音乐等第三方平台没有隶属或代理关系。",
    },
  ],
  shell: {
    h1: "BakaGame 用户条款",
    paragraphs: [
      TERMS_SUMMARY,
      "BakaGame 按现状免费提供，不承诺服务可用性，也不承诺数据永久保留。",
    ],
    links: linksExcept(SITE_PAGE_ENTRIES.terms.path),
  },
});
