/// <reference types="vite/client" />

/**
 * 构建期注入的提交历史，由 vite.config.ts 的 commit-history 插件提供。
 * 数据随 JS 产物带 hash 发布，不再作为 public/ 下的固定 URL 资源。
 */
declare module "virtual:commit-history" {
  interface CommitEntry {
    hash: string;
    message: string;
    date: string;
    author: string;
  }

  const history: {
    generatedAt: string;
    currentCommit: string;
    commits: CommitEntry[];
  };

  export default history;
}

/**
 * 构建期扫描 public/emojis/ 得到的表情包清单，
 * 由 vite.config.ts 的 sticker-manifest 插件提供。
 * 数据随分包产物带 hash 发布，不再作为 public/ 下的固定 URL 资源。
 *
 * 这里只声明到 unknown：运行时校验由 lib/stickers.ts 承担，
 * 避免在类型层重复一份可能与实际扫描结果不一致的结构。
 */
declare module "virtual:sticker-manifest" {
  const manifest: { generatedAt: string; packs: unknown[] };
  export default manifest;
}
