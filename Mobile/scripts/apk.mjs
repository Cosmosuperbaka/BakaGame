#!/usr/bin/env node
// 构建 APK 的薄壳：按优先级找一个可用的 Gradle，不要求项目里有 wrapper jar。
// 1) android/gradlew(.bat)（若已用 Android Studio 或 `gradle wrapper` 生成）
// 2) PATH 上的 gradle
// 3) ~/.gradle/wrapper/dists 里已缓存的 Gradle 发行版（本机会命中 8.14.3，离线可用）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const androidDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "android");
const task = process.argv[2] || "assembleDebug";
const isWin = process.platform === "win32";

function findGradle() {
  const wrapper = path.join(androidDir, isWin ? "gradlew.bat" : "gradlew");
  if (fs.existsSync(wrapper)) return wrapper;

  const dists = path.join(os.homedir(), ".gradle", "wrapper", "dists");
  if (fs.existsSync(dists)) {
    // 选版本号最大的缓存发行版
    const candidates = [];
    for (const family of fs.readdirSync(dists)) {
      const familyDir = path.join(dists, family);
      if (!fs.statSync(familyDir).isDirectory()) continue;
      for (const hash of fs.readdirSync(familyDir)) {
        const bin = path.join(
          familyDir,
          hash,
          family.replace(/-(all|bin)$/, ""),
          "bin",
          isWin ? "gradle.bat" : "gradle"
        );
        if (fs.existsSync(bin)) candidates.push({ bin, version: family });
      }
    }
    candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    if (candidates.length > 0) return candidates[0].bin;
  }

  const probe = spawnSync(isWin ? "where" : "which", ["gradle"], { shell: false });
  if (probe.status === 0) return probe.stdout.toString().split(/\r?\n/)[0].trim();
  return null;
}

const gradle = findGradle();
if (!gradle) {
  console.error(
    "[apk] 未找到可用 Gradle。请用 Android Studio 打开 android/ 生成 wrapper，或安装 Gradle 8.9+ 后重试。"
  );
  process.exit(1);
}
console.log(`[apk] 使用 ${gradle} 执行 :app:${task}`);
const result = spawnSync(gradle, [":app:" + task], {
  cwd: androidDir,
  stdio: "inherit",
  shell: isWin,
});
process.exit(result.status ?? 1);
