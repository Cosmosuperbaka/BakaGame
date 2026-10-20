/// <reference types="vite/client" />

/**
 * 构建期注入的提交历史，由 vite.config.ts 的 commit-history 插件提供。
 * 取数优先调 GitHub 接口（构建容器是浅克隆，git log 只有 HEAD 一条），
 * 取不到时降级为本地 git 日志，再降到空数组；运行时不再发任何请求。
 * 数据随 JS 产物带 hash 发布，不再作为 public/ 下的固定 URL 资源。
 *
 * 形状与 `src/lib/CommitHistory.ts` 的 `CommitHistory` 必须一致。
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
 * 构建期从 `src/data/changelog.json` 解析出的展示版本号（日志里的最大版本号），
 * 由 vite.config.ts 的 app-version 插件提供。落地页与 Sentry 只要这一个字符串，
 * 不再静态 import 整份日志数据；完整更新日志仍由按需加载的致谢页取。
 * 无条目时为空串，消费方按各自口径显示占位版本号。
 */
declare module "virtual:app-version" {
  const version: string;
  export default version;
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

/**
 * 构建期扫描 Client 安装的依赖闭包生成的开源致谢清单，
 * 由 vite.config.ts 的 credits-manifest 插件提供。
 * 只有元数据：许可证原文按包名首字母分桶懒加载，见下面的两个模块。
 *
 * 形状与 `src/lib/Credits.ts` 的 `CreditsManifest` 必须一致。
 */
declare module "virtual:credits" {
  const manifest: import("./lib/Credits").CreditsManifest;
  export default manifest;
}

/**
 * 许可证原文的桶加载映射：桶键 → `() => import("virtual:credits-licenses-<桶>")`。
 * 页面静态 import 这个映射，体积可以忽略；打开某个包的抽屉时才下载它所在的那一桶。
 *
 * 形状与 `src/lib/Credits.ts` 的 `CreditLicenseLoaders` 必须一致。
 */
declare module "virtual:credits-licenses" {
  const loaders: import("./lib/Credits").CreditLicenseLoaders;
  export default loaders;
}

/**
 * 单个许可证桶：包名 → 该包附带的许可证原文文件列表。
 * 形状与 `src/lib/Credits.ts` 的 `CreditLicenseBucket` 必须一致。
 */
declare module "virtual:credits-licenses-*" {
  const bucket: import("./lib/Credits").CreditLicenseBucket;
  export default bucket;
}
