/**
 * 可收录页面的元信息与静态外壳内容（单一真相源）的对外枢纽。
 *
 * 为什么集中在这里：同一份文案有两个消费者——
 *   1. 页面组件的 `Seo`（运行时把标签写进 head）；
 *   2. 构建期的静态外壳注入（`vite.config.ts` 的 staticShellPlugin，把正文与 head 标签写进 dist 的 HTML）。
 * 分散在两处必然漂移：改了描述忘了改外壳，爬虫与用户拿到的就不是同一份内容。
 *
 * 公共骨架（站点常量、形状、head/结构化数据助手）在 `pages/Shared.ts`，每页文案各自成文件
 * （`pages/<页>.ts`）；这里把它们汇成 PAGE_META，并原样转出公共 API，所有消费者仍从
 * `@/data/PageMeta` 取数。骨架与各页都保持零依赖（不 import React、组件或任何浏览器 API），
 * 因为 vite.config 在构建期（Node 环境）也要读它们。
 */

import { ABOUTS_PAGE_META } from "./pages/Abouts.ts";
import { CHANGELOG_PAGE_META, PRIVACY_PAGE_META, TERMS_PAGE_META } from "./pages/AboutsTabPages.ts";
import { CEE_PAGE_META } from "./pages/Cee.ts";
import { FAKER_PAGE_META } from "./pages/Faker.ts";
import { HOME_PAGE_META } from "./pages/Home.ts";
import { SONG_PAGE_META } from "./pages/Song.ts";
import {
  buildBreadcrumbStructuredData,
  buildFaqStructuredData,
  buildHeadTags,
  DEFAULT_OG_IMAGE,
  DEFAULT_OG_IMAGE_ALT,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  REPOSITORY_URL,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_SLOGAN,
  SITE_TAGLINE,
  type HeadTag,
  type PageMeta,
  type RuntimePageMeta,
} from "./pages/Shared.ts";

export {
  buildBreadcrumbStructuredData,
  buildFaqStructuredData,
  buildHeadTags,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  REPOSITORY_URL,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_SLOGAN,
  SITE_TAGLINE,
  type HeadTag,
  type PageMeta,
  type RuntimePageMeta,
};

export const PAGE_META: PageMeta[] = [
  HOME_PAGE_META,
  FAKER_PAGE_META,
  SONG_PAGE_META,
  CEE_PAGE_META,
  ABOUTS_PAGE_META,
  CHANGELOG_PAGE_META,
  PRIVACY_PAGE_META,
  TERMS_PAGE_META,
];

const roomInvite = (
  game: string,
  zh: string,
  file: string,
  image: string,
  imageAlt: string
): RuntimePageMeta => ({
  file,
  title: `${game} 房间邀请 - ${SITE_NAME}`,
  description: `朋友在 ${SITE_NAME} 开了一间${zh}。点开链接，填个昵称进房；设了密码的房间问房主要。`,
  image,
  imageAlt,
});

/** 站内没有的地址。客户端的「页面不存在」页与 404.html 外壳共用这份文案。 */
export const NOT_FOUND_PAGE: RuntimePageMeta = {
  file: "404.html",
  title: `页面不存在 - ${SITE_NAME}`,
  description: `这个地址在 ${SITE_NAME} 上没有对应的页面。谁是卧底、听歌猜歌、猜动漫角色都从首页进。`,
  image: DEFAULT_OG_IMAGE,
  imageAlt: DEFAULT_OG_IMAGE_ALT,
};

export const RUNTIME_PAGES: RuntimePageMeta[] = [
  roomInvite(
    "Who is Faker",
    "谁是卧底",
    "whoisfaker/room.html",
    `${SITE_ORIGIN}/og/og-faker.jpg`,
    "Who is Faker 分享卡片：游戏图标与谁是卧底字样"
  ),
  roomInvite(
    "Songuessr",
    "听歌猜歌",
    "songuessr/room.html",
    `${SITE_ORIGIN}/og/og-song.jpg`,
    "Songuessr 分享卡片：游戏图标与听歌猜歌字样"
  ),
  roomInvite(
    "CEE",
    "猜动漫角色",
    "cee/room.html",
    `${SITE_ORIGIN}/og/og-cee.jpg`,
    "CEE 分享卡片：游戏图标与猜动漫角色字样"
  ),
  // 状态、单人、排位与后台共用一份：它们没有可分享的固定内容，只需要不被当成首页。
  {
    file: "runtime.html",
    title: SITE_NAME,
    description: `${SITE_NAME} 是开给二次元朋友的游戏室：谁是卧底、听歌猜歌、猜动漫角色。`,
    image: DEFAULT_OG_IMAGE,
    imageAlt: DEFAULT_OG_IMAGE_ALT,
  },
  NOT_FOUND_PAGE,
];

/**
 * 按路径取页面元信息。未登记的路径（房间页、单人页等运行时页面）返回 undefined，
 * 由调用方显式提供 description——这些页面已标 noindex，不进静态外壳。
 */
export function findPageMeta(path: string): PageMeta | undefined {
  return PAGE_META.find((item) => item.path === path);
}
