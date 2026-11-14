import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLIENT_VERSION_PATTERN } from "../src/transport/routes/ClientChannelRoutes";

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
/** Windows 工作区按 core.autocrlf 检出为 CRLF，解析前统一成 LF，断言才与检出方式无关。 */
const read = (relativePath: string): string =>
  readFileSync(resolve(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");

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

/** 闸门取接口那一份：测试自己写一份，放宽会让预发布版本整个壳换不到票，收紧则误报漏改。 */
const CLIENT_VERSION = new RegExp(CLIENT_VERSION_PATTERN);

test("版本号闸门与服务端接口同一口径：预发布与构建后缀不被接受", () => {
  for (const version of ["0.2.0-beta.1", "1.0.0+build.5", "v1.0.0", "1.0.0.0.0", ""]) {
    expect(version).not.toMatch(CLIENT_VERSION);
  }
  for (const version of ["0.1.0", "1.2.3", "1.0", "1.2.3.4"]) {
    expect(version).toMatch(CLIENT_VERSION);
  }
});

test("桌面壳：bundle 版本与上报版本一致", () => {
  const bundleVersion = jsonVersion("Desktop/src-tauri/tauri.conf.json");
  const reportedVersion = cargoPackageVersion(read("Desktop/src-tauri/Cargo.toml"));

  expect(bundleVersion).toMatch(CLIENT_VERSION);
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

  expect(packageVersion).toMatch(CLIENT_VERSION);
  expect(gradleVersionName(gradle)).toBe(packageVersion);
});

test("安卓壳：versionCode 是正整数（升级安装的前提）", () => {
  // 不拿 Mobile/package-lock.json 比对：它由 npm 在壳目录里自行生成，
  // 版本号以 package.json 为准，versionCode 本就与它无关。
  const versionCode = read("Mobile/android/app/build.gradle").match(
    /^\s*versionCode\s+(\d+)\s*$/m
  )?.[1];

  expect(versionCode).toBeDefined();
  expect(Number(versionCode)).toBeGreaterThanOrEqual(1);
});
