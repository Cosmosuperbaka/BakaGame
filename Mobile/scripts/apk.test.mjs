import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cachedGradleFor, declaredGradleVersion } from "./apk.mjs";

/**
 * 「本地按 wrapper 构建」这条路径的版本选取（审查 F61）。
 * 取哪一枚 Gradle 决定本地构建能不能跑：AGP 只支持它那一侧的 Gradle 区间，
 * 而缓存里往往同时留着好几枚。夹具用真实的目录形态（family/hash/install/bin），
 * 因为被守护的正是这套布局的解析，不是抽象字符串。
 */

const makeDists = (entries) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gradle-dists-"));
  for (const [family, hash, install] of entries) {
    const binDir = path.join(root, family, hash, install, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    // 两种形态都放，测试里显式指定 win 与否，同一个夹具就能跨平台跑。
    fs.writeFileSync(path.join(binDir, "gradle"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(binDir, "gradle.bat"), "@echo off\n");
  }
  return root;
};

const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

test("wrapper 声明的解析：bin 与 all 两种分发形态、转义的冒号都要认", () => {
  const write = (url) => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-props-")),
      "gradle-wrapper.properties"
    );
    fs.writeFileSync(file, `distributionBase=GRADLE_USER_HOME\ndistributionUrl=${url}\n`);
    return file;
  };
  for (const [url, expected] of [
    ["https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip", "8.14.3"],
    ["https\\://services.gradle.org/distributions/gradle-8.14.3-all.zip", "8.14.3"],
    ["https\\://example.com/mirror/gradle-9.0-bin.zip", "9.0"],
  ]) {
    const file = write(url);
    assert.equal(declaredGradleVersion(file), expected, url);
    cleanup(path.dirname(file));
  }
});

test("wrapper 不存在或没有 distributionUrl 时返回空串，不猜版本", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-missing-"));
  assert.equal(declaredGradleVersion(path.join(dir, "gradle-wrapper.properties")), "");
  fs.writeFileSync(
    path.join(dir, "gradle-wrapper.properties"),
    "distributionBase=GRADLE_USER_HOME\n"
  );
  assert.equal(declaredGradleVersion(path.join(dir, "gradle-wrapper.properties")), "");
  cleanup(dir);
});

test("缓存里同时有更大版本时，选声明的那一枚而不是最大的", () => {
  // 本机实测过的形态：8.14.3（AGP 8.7 支持）与 9.7.1（不支持）并存在缓存里。
  const dists = makeDists([
    ["gradle-9.7.1-bin", "aaa", "gradle-9.7.1"],
    ["gradle-8.14.3-all", "bbb", "gradle-8.14.3"],
  ]);
  for (const win of [true, false]) {
    const found = cachedGradleFor(dists, "8.14.3", win);
    assert.ok(found, win ? "win 形态没找到" : "posix 形态没找到");
    assert.deepEqual(path.relative(dists, found).split(path.sep).slice(0, 3), [
      "gradle-8.14.3-all",
      "bbb",
      "gradle-8.14.3",
    ]);
    assert.equal(path.basename(found), win ? "gradle.bat" : "gradle");
  }
  cleanup(dists);
});

test("声明的那枚没缓存时返回 null，不回落到别的版本", () => {
  const dists = makeDists([["gradle-9.7.1-bin", "aaa", "gradle-9.7.1"]]);
  assert.equal(cachedGradleFor(dists, "8.14.3", false), null);
  assert.equal(cachedGradleFor(dists, "", false), null);
  cleanup(dists);
});

test("只有目录没有 bin 时不算命中", () => {
  // 防「family 名字对上了就返回路径」：那会把一个不存在的可执行文件交给 spawnSync。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gradle-dists-empty-"));
  fs.mkdirSync(path.join(root, "gradle-8.14.3-bin", "aaa", "gradle-8.14.3"), { recursive: true });
  assert.equal(cachedGradleFor(root, "8.14.3", false), null);
  cleanup(root);
});

test("dists 目录不存在时返回 null", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gradle-dists-none-"));
  const missing = path.join(root, "nope");
  assert.equal(cachedGradleFor(missing, "8.14.3", false), null);
  cleanup(root);
});

test("被 import 时不触发构建：入口判定用 argv，脚本体在守卫里", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./apk.mjs", import.meta.url)), "utf8");
  assert.match(
    source,
    /if \(process\.argv\[1\] && path\.resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\)/,
    "apk.mjs 的构建调用必须待在入口守卫里，否则测试一 import 就跑一次 gradle"
  );
});
