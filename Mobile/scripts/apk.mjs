#!/usr/bin/env node
// 构建 APK 的薄壳：按优先级找一个可用的 Gradle，不要求项目里有 wrapper jar。
// 1) android/gradlew(.bat)（若已用 Android Studio 或 `gradle wrapper` 生成，它自己读 wrapper 声明）
// 2) 本地缓存里**与 wrapper 声明同一枚**的 Gradle（离线可用）
// 3) PATH 上的 gradle
// 找不到就报错，绝不退回「缓存里版本号最大的那一枚」：本机缓存同时存在 8.14.3 与 9.7.1/9.8.1，
// 取最大会拿 Gradle 9 去配 AGP 8.7.3（只支持 8.x），表现是本地构建失败而 CI 全绿（审查 F61）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const androidDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "android");
const wrapperProperties = path.join(androidDir, "gradle", "wrapper", "gradle-wrapper.properties");
const isWin = process.platform === "win32";

/** wrapper 声明的 Gradle 版本。properties 里的 `:` 是转义写的，所以前缀按任意非空白吃掉。 */
export function declaredGradleVersion(propertiesPath) {
  if (!fs.existsSync(propertiesPath)) return "";
  const text = fs.readFileSync(propertiesPath, "utf8");
  return /distributionUrl=\S*gradle-([\d.]+)-(?:bin|all)\.zip/.exec(text)?.[1] ?? "";
}

/**
 * 在 `~/.gradle/wrapper/dists` 里找与声明版本同一枚发行版的可执行文件。
 * `-bin` 与 `-all` 是同一枚的两个分发形态，都算命中；哈希子目录名不解析，只认能否走到 bin。
 */
export function cachedGradleFor(distsDir, version, win = isWin) {
  if (!version || !fs.existsSync(distsDir)) return null;
  const bin = win ? "gradle.bat" : "gradle";
  for (const family of fs.readdirSync(distsDir)) {
    if (!family.startsWith(`gradle-${version}-`)) continue;
    const familyDir = path.join(distsDir, family);
    if (!fs.statSync(familyDir).isDirectory()) continue;
    for (const hash of fs.readdirSync(familyDir)) {
      const candidate = path.join(familyDir, hash, family.replace(/-(?:all|bin)$/, ""), "bin", bin);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findGradle() {
  const wrapper = path.join(androidDir, isWin ? "gradlew.bat" : "gradlew");
  if (fs.existsSync(wrapper)) return wrapper;

  const cached = cachedGradleFor(
    path.join(os.homedir(), ".gradle", "wrapper", "dists"),
    declaredGradleVersion(wrapperProperties)
  );
  if (cached) return cached;

  const probe = spawnSync(isWin ? "where" : "which", ["gradle"], { shell: false });
  if (probe.status === 0) return probe.stdout.toString().split(/\r?\n/)[0].trim();
  return null;
}

// 允许被测试 import 而不触发一次真实构建。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const task = process.argv[2] || "assembleDebug";
  const gradle = findGradle();
  if (!gradle) {
    const version = declaredGradleVersion(wrapperProperties);
    console.error(
      `[apk] 未找到 Gradle ${version || "（wrapper 没有声明版本）"}。` +
        "可用 Android Studio 打开 android/ 生成 wrapper、装该版本，或在 PATH 上放一枚同版本 gradle。" +
        "本壳不改用缓存里的其它版本：AGP 的支持范围写在 android/build.gradle。"
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
}
