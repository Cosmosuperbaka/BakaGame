import {
  ABOUTS_SUMMARY,
  DEFAULT_OG_IMAGE_ALT,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_PAGE_ENTRIES,
  SITE_TAGLINE,
  type PageMeta,
} from "./Shared.ts";

export const ABOUTS_PAGE_META: PageMeta = {
  ...SITE_PAGE_ENTRIES.abouts,
  title: `关于 ${SITE_NAME}：更新日志、开源致谢与隐私条款`,
  lastmod: "2026-11-14",
  description: `${SITE_TAGLINE}BakaGame 的更新日志、提交历史、开源致谢、隐私说明与用户条款都在这一页，每个前端依赖的许可证原文都能按包查看。`,
  image: `${SITE_ORIGIN}/og/og-home.jpg`,
  imageAlt: DEFAULT_OG_IMAGE_ALT,
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
      { href: SITE_PAGE_ENTRIES.changelog.path, label: "更新日志" },
      { href: SITE_PAGE_ENTRIES.privacy.path, label: "隐私说明" },
      { href: SITE_PAGE_ENTRIES.terms.path, label: "用户条款" },
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
};
