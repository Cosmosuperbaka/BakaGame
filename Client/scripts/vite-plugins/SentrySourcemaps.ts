/**
 * 生产构建时把 source map 传给 Sentry，并创建与运行时一致的 release。
 *
 * 线上页面由托管平台按同一条构建命令自己构建，产物与 CI 那份并不逐字相同（提交历史模块带
 * 构建时间），所以上传只能发生在真正被部署的那次构建里：凭据配在托管平台的构建环境变量上，
 * CI 与本地没有凭据时整段关闭，**连 map 文件都不产出**——否则 hidden map 会随 dist 一起被公开托管。
 *
 * 符号化靠插件注入的 debug ID，不依赖 release 名对齐；release 名仍按运行时同一口径
 * （`V<版本>（<7 位提交>）`）创建，问题页才能按版本归并。
 */
import fs from "node:fs";
import { execSync } from "node:child_process";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { latestVersionOf } from "../../src/lib/Changelog.ts";

export interface SentrySourcemapEnv {
  SENTRY_AUTH_TOKEN?: string;
  SENTRY_ORG?: string;
  SENTRY_PROJECT?: string;
}

/** 三项凭据齐全才上传：缺任一项都按「不上传、不产出 map」处理，不半途失败。 */
export const sourcemapUploadEnabled = (env: SentrySourcemapEnv): boolean =>
  Boolean(env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT);

/** 与 `src/lib/Sentry.ts` 的运行时 release 同一口径；取不到提交时不建 release。 */
export const sentryReleaseName = (changelogPath: string, revision: string): string | undefined => {
  if (!revision) return undefined;
  const version = latestVersionOf(fs.readFileSync(changelogPath, "utf8")) || "0.0.0";
  return `V${version}（${revision.slice(0, 7)}）`;
};

const gitRevision = (): string => {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
};

export function sentrySourcemapsPlugin(changelogPath: string, env: SentrySourcemapEnv) {
  if (!sourcemapUploadEnabled(env)) return [];
  const release = sentryReleaseName(changelogPath, gitRevision());
  return sentryVitePlugin({
    org: env.SENTRY_ORG,
    project: env.SENTRY_PROJECT,
    authToken: env.SENTRY_AUTH_TOKEN,
    telemetry: false,
    release: release ? { name: release, inject: false, setCommits: false } : { create: false },
    sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
  });
}
