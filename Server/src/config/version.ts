import packageJson from "../../package.json";

// ==================== 构建版本信息 ====================

/**
 * 语义化版本号已作废：项目尚未上线，package.json 的 version 不再代表任何东西，
 * 用户可见的版本号一律取 Client/public/changelog.json 里的最大版本号。
 * 服务端自身没有版本概念，对外一律报 ∞，避免又冒出第三套版本号。
 */
export const VERSION_RETIRED = "∞";

export interface VersionInfo {
  name: string;
  version: string;
  commit: string;
  buildTime: string;
}

// 版本号恒为 ∞，真正用于定位构建的是 commit。
export const createVersionInfo = (commit: string): VersionInfo => ({
  name: packageJson.name,
  version: VERSION_RETIRED,
  commit,
  buildTime: new Date().toISOString(),
});
