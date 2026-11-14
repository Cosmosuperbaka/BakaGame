import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLIENT_VERSION_PATTERN } from "../src/transport/routes/ClientChannelRoutes";

/**
 * 每个壳的版本值只在一处写，别处派生；这里守的是「派生关系没被改回手抄」，而不是三处相等：
 *
 * - 桌面：版本只写在 `Cargo.toml`。`tauri.conf.json` 不声明 version，Tauri 回落到 Cargo 清单：
 *   bundle 文件名（`BakaGame_<ver>_x64-setup.exe`，`ci.yml` 的发布作业正是从文件名里 `sed`
 *   出这一版号推 R2）与壳层经 `env!("CARGO_PKG_VERSION")` 上报给服务端的 `clientVersion`
 *   因此是同一个值。
 * - 安卓：版本只写在 `Mobile/package.json`。桥接脚本由 `scripts/prepare-web.mjs` 取它，
 *   `app/build.gradle` 构建时直接读它：versionName 原样取用，versionCode 由它推导。
 *
 * 漏改的症状都很隐蔽：文件名是新的、上报的是旧的，服务端一直判定"有新版本"，用户在最新包上
 * 反复收到更新提示；versionCode 漏抬则升级包装不上。0.1.0 时各处恰好相等，掩盖了这个结构问题。
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

test("桌面壳：版本只写在 Cargo.toml，tauri.conf.json 不再声明", () => {
  // 声明了就多出第二个来源：bundle 文件名取它、上报取 Cargo.toml，漏改一处两者就分叉
  expect(jsonVersion("Desktop/src-tauri/tauri.conf.json")).toBe("");
  expect(read("Desktop/src-tauri/tauri.conf.json")).not.toMatch(/"version"\s*:/);
  expect(cargoPackageVersion(read("Desktop/src-tauri/Cargo.toml"))).toMatch(CLIENT_VERSION);
});

test("桌面壳：Cargo.lock 记录的版本跟上了 Cargo.toml", () => {
  const lock = read("Desktop/src-tauri/Cargo.lock");
  const entry = lock.match(/\[\[package\]\]\nname = "bakagame-desktop"\nversion = "([^"]+)"/);

  expect(entry?.[1]).toBe(cargoPackageVersion(read("Desktop/src-tauri/Cargo.toml")));
});

/** 已发出去的最高 versionCode：推导值低于它，系统与应用商店会拒绝升级安装。发了新包就把它抬上来。 */
const SHIPPED_VERSION_CODE_FLOOR = 3;

test("安卓壳：versionName 与 versionCode 不手写，都由 Mobile/package.json 派生", () => {
  const gradle = read("Mobile/android/app/build.gradle");

  expect(gradle).toMatch(/JsonSlurper\(\)\.parse\(file\('\.\.\/\.\.\/package\.json'\)\)\.version/);
  expect(gradle).toMatch(/^\s*versionName\s+bakaVersionName\s*$/m);
  expect(gradle).toMatch(/^\s*versionCode\s+bakaVersionCode\s*$/m);
  // 公式本身就是规则：改它等于改版本号语义，必须连同本测试一起改
  expect(gradle).toContain(
    "bakaVersionNumbers[0] * 10000 + bakaVersionNumbers[1] * 100 + bakaVersionNumbers[2]"
  );
});

test("安卓壳：package.json 版本能推导出不低于已发布值的 versionCode", () => {
  const version = jsonVersion("Mobile/package.json");
  expect(version).toMatch(CLIENT_VERSION);

  const parts = version.split(".").map(Number);
  // 推导只认三段，且 minor、patch 不超过 99，否则不同版本会撞同一个 versionCode
  expect(parts).toHaveLength(3);
  const [major = 0, minor = 0, patch = 0] = parts;
  expect(minor).toBeLessThanOrEqual(99);
  expect(patch).toBeLessThanOrEqual(99);
  expect(major * 10000 + minor * 100 + patch).toBeGreaterThanOrEqual(SHIPPED_VERSION_CODE_FLOOR);
});
