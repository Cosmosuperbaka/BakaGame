import path from "path";
import { describe, expect, it } from "vitest";
import {
  isProductionBuild,
  sentryReleaseName,
  sentryReleaseOptions,
  sentrySourcemapsPlugin,
  sourcemapUploadEnabled,
} from "../../scripts/vite-plugins/SentrySourcemaps";
import { latestVersionOf } from "./Changelog";
import changelog from "../data/changelog.json?raw";

const CHANGELOG = path.resolve(import.meta.dirname, "../data/changelog.json");
const FULL = { SENTRY_AUTH_TOKEN: "t", SENTRY_ORG: "o", SENTRY_PROJECT: "p" };

describe("Sentry source map 上传开关", () => {
  it("三项凭据齐全才上传，缺任一项整段关闭（连 map 都不产出）", () => {
    expect(sourcemapUploadEnabled(FULL)).toBe(true);
    for (const key of Object.keys(FULL) as (keyof typeof FULL)[])
      expect(sourcemapUploadEnabled({ ...FULL, [key]: "" })).toBe(false);
    expect(sentrySourcemapsPlugin(CHANGELOG, {})).toEqual([]);
  });

  it("release 名与运行时同一口径：最新日志版本 + 7 位提交，取不到提交时不建", () => {
    const version = latestVersionOf(changelog) || "0.0.0";
    expect(sentryReleaseName(CHANGELOG, "0123456789abcdef")).toBe(`V${version}（0123456）`);
    expect(sentryReleaseName(CHANGELOG, "")).toBeUndefined();
  });

  it("会上线的构建记一次生产部署：托管平台与主分支算，别的分支不算", () => {
    expect(isProductionBuild({})).toBe(true);
    expect(isProductionBuild({ GITHUB_REF: "refs/heads/main" })).toBe(true);
    expect(isProductionBuild({ GITHUB_REF: "refs/heads/feature" })).toBe(false);
    expect(isProductionBuild({ GITHUB_REF: "refs/pull/1/merge" })).toBe(false);

    expect(sentryReleaseOptions("V1.0.0（0123456）", {})).toEqual({
      name: "V1.0.0（0123456）",
      inject: false,
      deploy: { env: "production" },
    });
    expect(sentryReleaseOptions("V1.0.0（0123456）", { GITHUB_REF: "refs/heads/feature" })).toEqual(
      {
        name: "V1.0.0（0123456）",
        inject: false,
      }
    );
  });

  it("提交关联交给插件默认的尽力而为：不显式写，失败才不会连带跳过部署记录", () => {
    expect(sentryReleaseOptions("V1.0.0（0123456）", {})).not.toHaveProperty("setCommits");
    expect(sentryReleaseOptions(undefined, {})).toEqual({ create: false });
  });

  it("凭据齐全时这组选项能通过插件自己的校验并装出插件", () => {
    const plugins = [sentrySourcemapsPlugin(CHANGELOG, FULL)].flat();
    expect(plugins.length).toBeGreaterThan(0);
  });
});
