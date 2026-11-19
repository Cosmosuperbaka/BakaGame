/**
 * 生产构建时把 source map 传给 Sentry，并创建与运行时一致的 release。
 *
 * 线上页面由托管平台按同一条构建命令自己构建，产物与 CI 那份并不逐字相同（提交历史模块带
 * 构建时间），所以上传只能发生在真正被部署的那次构建里：凭据配在托管平台的构建环境变量上，
 * CI 与本地没有凭据时整段关闭，**连 map 文件都不产出**——否则 hidden map 会随 dist 一起被公开托管。
 *
 * 符号化靠插件注入的 debug ID，不依赖 release 名对齐；release 名仍按运行时同一口径
 * （`V<版本>（<7 位提交>）`）创建，问题页才能按版本归并。
 *
 * 会上线的构建另给这个 release 记一次生产部署，并尽力关联提交，报错才能跳到对应的版本与改动。
 * 这两步失败只记日志、不影响构建与 map 上传。
 */
import fs from "node:fs";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { latestVersionOf } from "../../src/lib/Changelog.ts";
import { formatReleaseName } from "../../src/lib/ReleaseName.ts";
import { gitRevision } from "./GitRevision.ts";

export interface SentrySourcemapEnv {
  SENTRY_AUTH_TOKEN?: string;
  SENTRY_ORG?: string;
  SENTRY_PROJECT?: string;
  /** 持续集成给出的分支引用；托管平台的构建环境里没有它。 */
  GITHUB_REF?: string;
}

/** 三项凭据齐全才上传：缺任一项都按「不上传、不产出 map」处理，不半途失败。 */
export const sourcemapUploadEnabled = (env: SentrySourcemapEnv): boolean =>
  Boolean(env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT);

/** 与 `src/lib/Sentry.ts` 的运行时 release 同一口径；取不到提交时不建 release。 */
export const sentryReleaseName = (changelogPath: string, revision: string): string | undefined => {
  if (!revision) return undefined;
  return formatReleaseName(latestVersionOf(fs.readFileSync(changelogPath, "utf8")) ?? "", revision);
};

/**
 * 这次构建的产物会不会上线：托管平台只构建主分支；持续集成里只有主分支的构建会被打进安装包与
 * 热更新包发布。别的分支带着凭据构建时照常上传 map，但不能记成一次生产部署。
 */
export const isProductionBuild = (env: SentrySourcemapEnv): boolean =>
  !env.GITHUB_REF || env.GITHUB_REF === "refs/heads/main";

/**
 * 交给插件的 release 选项。提交关联不写 `setCommits`：插件默认按自动方式尽力而为，监控平台没接
 * 代码仓库时静默跳过；显式写出来的话，关联一失败就会连同后面的收尾与部署记录一起跳过。
 */
export const sentryReleaseOptions = (release: string | undefined, env: SentrySourcemapEnv) =>
  release
    ? {
        name: release,
        inject: false,
        ...(isProductionBuild(env) ? { deploy: { env: "production" } } : {}),
      }
    : { create: false };

export function sentrySourcemapsPlugin(changelogPath: string, env: SentrySourcemapEnv) {
  if (!sourcemapUploadEnabled(env)) return [];
  const release = sentryReleaseName(changelogPath, gitRevision());
  return sentryVitePlugin({
    org: env.SENTRY_ORG,
    project: env.SENTRY_PROJECT,
    authToken: env.SENTRY_AUTH_TOKEN,
    telemetry: false,
    release: sentryReleaseOptions(release, env),
    sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
  });
}
