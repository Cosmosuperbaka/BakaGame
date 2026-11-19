import type { CreditsTab } from "@/components/credits/CreditsView";
import { SITE_PAGE_ENTRIES } from "@bakagame/shared/values";

/**
 * 关于项目页的标签与地址。
 *
 * 更新日志、隐私说明、用户条款各有一个独立路径（登记在共享契约的公开页里），能被单独收录与分享；
 * 开源致谢就是 `/abouts` 本身，提交历史只是 GitHub 的镜像，不值得单独收录，仍写在 `?tab=` 里。
 * 无论走哪个地址，渲染的都是关于页的同一份正文。
 */

export const ABOUTS_TABS: readonly CreditsTab[] = [
  "credits",
  "changelog",
  "commits",
  "privacy",
  "terms",
];

export const ABOUTS_PATH = SITE_PAGE_ENTRIES.abouts.path;

/** 有独立路径的标签；数组顺序无意义，查表用。 */
const TAB_PATHS: Partial<Record<CreditsTab, string>> = {
  changelog: SITE_PAGE_ENTRIES.changelog.path,
  privacy: SITE_PAGE_ENTRIES.privacy.path,
  terms: SITE_PAGE_ENTRIES.terms.path,
};

/** 独立路径相对 `/abouts` 的那一段，路由装配用。 */
export const ABOUTS_TAB_SEGMENTS: readonly string[] = Object.values(TAB_PATHS).map((path) =>
  path.slice(ABOUTS_PATH.length + 1)
);

export const isAboutsTab = (value: string | null): value is CreditsTab =>
  value !== null && ABOUTS_TABS.includes(value as CreditsTab);

/** 某个标签的规范地址：有独立路径的用路径，开源致谢是 `/abouts`，其余挂在 `?tab=` 上。 */
export function aboutsTabHref(tab: CreditsTab): string {
  const path = TAB_PATHS[tab];
  if (path) return path;
  return tab === "credits" ? ABOUTS_PATH : `${ABOUTS_PATH}?tab=${tab}`;
}

/** 路径对应的独立标签；`/abouts` 本身与未登记的路径返回 undefined。 */
export function aboutsTabOfPath(pathname: string): CreditsTab | undefined {
  return ABOUTS_TABS.find((tab) => TAB_PATHS[tab] === pathname);
}

/** 关于页的任一地址（含各标签的独立路径）：页面过渡把它们当作同一张页面。 */
export const isAboutsPath = (pathname: string): boolean =>
  pathname === ABOUTS_PATH || aboutsTabOfPath(pathname) !== undefined;
