/**
 * 站名与公开页的最小登记：页面元信息（客户端）与 Agent 地图（服务端）共用这一份。
 *
 * 只放路径与短标题这两个会被两端同时引用的事实；页面长文案留在客户端的页面元信息里，
 * Agent 地图的用途说明留在服务端，各写各的，改名时只改这里。
 * 零依赖：客户端构建期的 Node 脚本也会直接加载它。
 */
export const SITE_NAME = "BakaGame";

export interface SitePageEntry {
  readonly path: string;
  /** 短名：面包屑、站内链接与 Agent 地图的标题都由它派生，不带站名后缀。 */
  readonly shortTitle: string;
}

export const SITE_PAGE_ENTRIES = {
  home: { path: "/", shortTitle: SITE_NAME },
  faker: { path: "/whoisfaker", shortTitle: "谁是卧底 Who is Faker" },
  song: { path: "/songuessr", shortTitle: "听歌猜歌 Songuessr" },
  cee: { path: "/cee", shortTitle: "猜动漫角色 CEE" },
  abouts: { path: "/abouts", shortTitle: `关于 ${SITE_NAME}` },
  // 关于页里各有独立地址的三个标签：正文仍是关于页的那一份，地址让它们能被单独收录与分享。
  changelog: { path: "/abouts/changelog", shortTitle: "更新日志" },
  privacy: { path: "/abouts/privacy", shortTitle: "隐私说明" },
  terms: { path: "/abouts/terms", shortTitle: "用户条款" },
} as const satisfies Record<string, SitePageEntry>;

/** 「中文名 英文名」形的短标题换成「英文名 中文名」，Agent 地图的大厅标题用它。 */
export const lobbyTitleOf = (shortTitle: string): string => {
  const [chinese = "", ...rest] = shortTitle.split(" ");
  return `${rest.join(" ")} ${chinese}大厅`;
};
