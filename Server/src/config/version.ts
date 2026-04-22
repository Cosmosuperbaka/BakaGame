import packageJson from "../../package.json";

// ==================== 构建版本信息 ====================

export interface VersionInfo {
  name: string;
  version: string;
  commit: string;
  buildTime: string;
}

// 把 package.json 版本号与当前构建元数据拼成对外展示用版本信息。
export const createVersionInfo = (commit: string): VersionInfo => ({
  name: packageJson.name,
  version: packageJson.version,
  commit,
  buildTime: new Date().toISOString(),
});
