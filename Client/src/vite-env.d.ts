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
