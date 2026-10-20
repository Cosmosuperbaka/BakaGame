import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * 构建工具链版本的一致性断言（审查 F61），用 `node --test` 运行，与 ServerCiFilter.mjs 同口径。
 *
 * 为什么不做成文档表格：同一条版本往往声明在两处以上——Gradle 同时写在
 * `Mobile/android/gradle/wrapper/gradle-wrapper.properties`（本地那条构建路径）、
 * `.github/workflows/ci.yml` 的 Setup Gradle（CI 那条）与 `Mobile/android/build.gradle` 的 AGP
 * 支持范围里；bun 同时写在 e2e 作业与工作区 pin 里；打包 CLI 同时写在 ci.yml 与 Cargo.lock 里。
 * 表格会在下一次升级时过期，而漂移的方向是固定的坏味道：**本地那条路径不可用，CI 全绿**。
 * 本文件不复制任何声明，只从真实文件解析后核对关系；升级时改声明即可，这里只保证它们仍互相兼容。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...segments) =>
  readFileSync(join(repoRoot, ...segments), "utf8").replaceAll("\r\n", "\n");

const workflow = read(".github/workflows/ci.yml");

/** 解析失败必须报红：静默返回 undefined 会让断言等于没在检查任何东西。 */
function declaredVersion(source, pattern, label) {
  const match = pattern.exec(source);
  assert.ok(match, `解析不到${label}：声明形式变了，本文件的正则要跟着改`);
  return match[1];
}

function parseVersion(raw, label) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(raw);
  assert.ok(match, `${label} 不是 x.y[.z] 版本号：${raw}`);
  return { raw, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

const cmp = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/**
 * AGP 版本 → 它要求的 Gradle 区间。数值出处是 Android Gradle plugin 的官方版本兼容表。
 * 表里只写「谁支持谁」，不写本仓库用了哪一枚（那是上面三处声明的事）。
 * 未登记的 AGP 版本一律报红：逼人补一条带出处的关系，而不是让兼容性静默通过。
 */
const GRADLE_FOR_AGP = {
  8.7: { min: "8.9", maxMajor: 8 },
};

const wrapperGradle = () =>
  parseVersion(
    declaredVersion(
      read("Mobile/android/gradle/wrapper/gradle-wrapper.properties"),
      /^distributionUrl=\S*gradle-([\d.]+)-(?:bin|all)\.zip$/m,
      "wrapper 的 distributionUrl"
    ),
    "wrapper 声明的 Gradle"
  );

const ciGradle = () =>
  parseVersion(
    declaredVersion(workflow, /^\s+gradle-version:\s*"?([\d.]+)"?$/m, "ci.yml 的 gradle-version"),
    "CI 声明的 Gradle"
  );

const agpVersion = () =>
  declaredVersion(
    read("Mobile/android/build.gradle"),
    /com\.android\.tools\.build:gradle:([\d.]+)/,
    "build.gradle 的 AGP 坐标"
  );

test("Gradle：本地 wrapper 与 CI 的 Setup Gradle 用同一枚", () => {
  const wrapper = wrapperGradle();
  const ci = ciGradle();
  assert.equal(
    cmp(wrapper, ci),
    0,
    `wrapper 是 ${wrapper.raw} 而 CI 是 ${ci.raw}：本地构建与 CI 构建不是同一套工具链`
  );
});

test("Gradle：落在 AGP 的支持范围内", () => {
  const agp = agpVersion();
  const requirement = GRADLE_FOR_AGP[agp.replace(/^(\d+\.\d+).*$/, "$1")];
  assert.ok(
    requirement,
    `AGP ${agp} 没有登记 Gradle 支持范围：先在官方兼容表确认区间，再补进 GRADLE_FOR_AGP`
  );
  const gradle = ciGradle();
  assert.equal(
    gradle.major <= requirement.maxMajor,
    true,
    `AGP ${agp} 只支持到 Gradle ${requirement.maxMajor}.x，现在声明的是 ${gradle.raw}`
  );
  assert.equal(
    cmp(gradle, parseVersion(requirement.min, "AGP 要求的最低 Gradle")) >= 0,
    true,
    `AGP ${agp} 要求 Gradle ≥ ${requirement.min}，现在声明的是 ${gradle.raw}`
  );
});

test("bun：e2e 作业的 Setup Bun 与工作区 pin 同一枚（bun 是测量仪器）", () => {
  const ci = parseVersion(
    declaredVersion(workflow, /^\s+bun-version:\s*"?([\d.]+)"?$/m, "ci.yml 的 bun-version"),
    "CI 声明的 bun"
  );
  const pinned = parseVersion(
    declaredVersion(
      read("Server/package.json"),
      /"bun":\s*"([\d.]+)"/,
      "Server/package.json 的 bun devDependency"
    ),
    "工作区 pin 的 bun"
  );
  assert.equal(
    cmp(ci, pinned),
    0,
    `e2e 装 ${ci.raw} 而工作区钉 ${pinned.raw}：覆盖率与冒烟的测量口径不一致`
  );
});

test("Node：各作业只用单点声明的主版本，且落在 engines 允许的线上", () => {
  const declared = [...workflow.matchAll(/^\s+node-version:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.ok(declared.length > 0, "ci.yml 里没有任何 node-version 输入，解析空转");
  for (const value of declared)
    assert.equal(
      value,
      "${{ env.NODE_VERSION }}",
      "作业写死了 Node 版本：主版本只在 ci.yml 顶部 env.NODE_VERSION 声明一次"
    );
  const major = Number(
    declaredVersion(workflow, /^ {2}NODE_VERSION:\s*"?(\d+)"?$/m, "env.NODE_VERSION")
  );
  const engines = declaredVersion(
    read("package.json"),
    /"engines":\s*\{[^}]*"node":\s*"([^"]+)"/,
    "根 package.json 的 engines.node"
  );
  // 只认 `>=x.y.z` 这一种形状：写成 || 复合范围时这里报红——改断言之前先确认 CI 的主版本仍被那个范围接受。
  const floor = /^>=(\d+)\.\d+\.\d+$/.exec(engines);
  assert.ok(
    floor,
    `engines.node 不是 >=x.y.z 形状（现在是 ${engines}）：CI 的 Node 主版本没有可核对的下界了`
  );
  assert.ok(
    major >= Number(floor[1]),
    `CI 用 Node ${major}，低于 engines.node 的 ${engines}：jsdom 等包会让 pnpm install --frozen-lockfile 硬失败`
  );
});

test("pnpm：版本只有根 packageManager 一个出处，作业不再单独钉一枚", () => {
  const usage = [...workflow.matchAll(/uses:\s*pnpm\/action-setup@/g)];
  assert.ok(usage.length > 0, "ci.yml 里没有 pnpm/action-setup，解析空转");
  // 只看每个 setup-pnpm 步骤紧跟的那几行：别处的 version: 输入（如发布元数据步骤）不归这里管。
  const pnpmPinsItsOwnVersion = [
    ...workflow.matchAll(/uses:\s*pnpm\/action-setup@[^\n]*\n((?:[ \t]*\S.*\n){0,4})/g),
  ].some((block) => /^[ \t]+(?:pnpm-)?version:[ \t]*\S/m.test(block[1]));
  assert.equal(
    pnpmPinsItsOwnVersion,
    false,
    "有作业给 setup-pnpm 传了 version 输入：pnpm 版本必须只由根 package.json 的 packageManager 决定"
  );
  assert.match(
    read("package.json"),
    /"packageManager":\s*"pnpm@[\d.]+"/,
    "根 package.json 缺少 packageManager 声明"
  );
});

test("桌面打包 CLI 与 tauri crate 同主次版本", () => {
  const cli = parseVersion(
    declaredVersion(workflow, /TAURI_CLI_VERSION:\s*"([\d.]+)"/, "ci.yml 的 TAURI_CLI_VERSION"),
    "打包用的 @tauri-apps/cli"
  );
  const crate = parseVersion(
    declaredVersion(
      read("Desktop/src-tauri/Cargo.lock"),
      /^name = "tauri"\nversion = "([\d.]+)"/m,
      "Cargo.lock 里的 tauri crate"
    ),
    "Cargo.lock 的 tauri"
  );
  assert.equal(
    `${cli.major}.${cli.minor}`,
    `${crate.major}.${crate.minor}`,
    `打包 CLI ${cli.raw} 与 tauri crate ${crate.raw} 主次版本不匹配：产出的安装包不由这套 CLI 定义`
  );
});

test("本文件挂在 Server CI 上，否则这套断言等于不存在", () => {
  assert.match(
    workflow,
    /node --test scripts\/BuildToolchain\.mjs/,
    "ci.yml 里不再运行 scripts/BuildToolchain.mjs：工具链一致性回到没人核对的状态"
  );
});
