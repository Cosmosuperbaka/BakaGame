import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 发布版本号的单一事实来源在两个壳各自的项目文件里，但每个壳都有**两个**消费方：
 *
 * - 桌面：`tauri.conf.json` 的 version 决定 bundle 文件名（`BakaGame_<ver>_x64-setup.exe`），
 *   `ci.yml` 的发布作业正是从文件名里 `sed` 出这一版号推 R2；而壳层经
 *   `env!("CARGO_PKG_VERSION")` 把 `Cargo.toml` 的 version 作为 `clientVersion` 上报给服务端。
 * - 安卓：`Mobile/package.json` 的 version 被 `scripts/prepare-web.mjs` 写进桥接脚本，
 *   同时又（本应）同步到 `app/build.gradle` 的 versionName，后者决定 APK 文件名。
 *
 * 两处只要有一处漏改，症状都很隐蔽：文件名是新的、上报的是旧的，于是服务端一直判定
 * "有新版本"，用户在最新包上反复收到更新提示。0.1.0 时两边恰好相等，掩盖了这个结构问题；
 * 这道测试就是为了让漏改在 CI 上直接红，而不是等上线后靠用户反馈发现。
 */

const repoRoot = resolve(import.meta.dir, "../..");
const read = (relativePath: string): string =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

const jsonVersion = (relativePath: string): string => {
  const parsed: unknown = JSON.parse(read(relativePath));
  if (typeof parsed !== "object" || parsed === null) return "";
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" ? version : "";
};

/** 只取 `[package]` 段里的 version，避免误命中依赖项的 version 行。 */
const cargoPackageVersion = (toml: string): string => {
  const section = toml.split(/^\[/m).find((part) => part.startsWith("package]"));
  const matched = section?.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return matched?.[1] ?? "";
};

const gradleVersionName = (gradle: string): string =>
  gradle.match(/^\s*versionName\s+['"]([^'"]+)['"]/m)?.[1] ?? "";

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

test("桌面壳：bundle 版本与上报版本一致", () => {
  const bundleVersion = jsonVersion("Desktop/src-tauri/tauri.conf.json");
  const reportedVersion = cargoPackageVersion(read("Desktop/src-tauri/Cargo.toml"));

  expect(bundleVersion).toMatch(SEMVER);
  expect(reportedVersion).toBe(bundleVersion);
});

test("桌面壳：Cargo.lock 记录的版本跟上了 Cargo.toml", () => {
  const lock = read("Desktop/src-tauri/Cargo.lock");
  const entry = lock.match(/\[\[package\]\]\nname = "bakagame-desktop"\nversion = "([^"]+)"/);

  expect(entry?.[1]).toBe(cargoPackageVersion(read("Desktop/src-tauri/Cargo.toml")));
});

test("安卓壳：versionName 与 Mobile/package.json 一致", () => {
  const packageVersion = jsonVersion("Mobile/package.json");
  const gradle = read("Mobile/android/app/build.gradle");

  expect(packageVersion).toMatch(SEMVER);
  expect(gradleVersionName(gradle)).toBe(packageVersion);
});

test("安卓壳：versionCode 是正整数（升级安装的前提）", () => {
  // 锁文件不行：Mobile/package-lock.json 被 .gitignore 排除（npm 自己生成），
  // 干净检出里并不存在，断言它会让本地绿、CI 红。
  const versionCode = read("Mobile/android/app/build.gradle").match(
    /^\s*versionCode\s+(\d+)\s*$/m
  )?.[1];

  expect(versionCode).toBeDefined();
  expect(Number(versionCode)).toBeGreaterThanOrEqual(1);
});
