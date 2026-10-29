import path from "path";
import { describe, expect, it } from "vitest";
import {
  sentryReleaseName,
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
});
