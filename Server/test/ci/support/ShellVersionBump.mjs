import { execFileSync } from "node:child_process";
import { repoRoot } from "./Workflow.mjs";

/**
 * 壳版本号门禁的判定与取数。
 *
 * 规范要求原生侧的修复连同版本号一起发（软更新提醒只按版本号比较）。判定只看
 * 「源码目录有改动而版本号文件的版本没变」，不关心改了什么，也不替人挑该抬哪一段。
 */

export const SHELLS = [
  {
    name: "桌面壳",
    sourcePrefix: "Desktop/src-tauri/src/",
    versionFile: "Desktop/src-tauri/Cargo.toml",
    // 清单里第一处 version = "…" 属于 [package]；依赖项的 version 写在它后面。
    readVersion: (text) => /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1],
  },
  {
    name: "移动壳",
    sourcePrefix: "Mobile/android/app/src/main/",
    versionFile: "Mobile/package.json",
    readVersion: (text) => {
      try {
        return JSON.parse(text).version;
      } catch {
        return undefined;
      }
    },
  },
];

/**
 * @param {string[]} changedFiles 与基线相比有变化的文件（仓库相对路径、正斜杠）
 * @param {(file: string) => string | undefined} versionBefore 基线里该版本号文件的版本
 * @param {(file: string) => string | undefined} versionAfter 当前该版本号文件的版本
 * @returns {string[]} 违规说明，空数组表示通过
 */
export function shellVersionViolations(changedFiles, versionBefore, versionAfter) {
  const problems = [];
  for (const shell of SHELLS) {
    const touched = changedFiles.filter((file) => file.startsWith(shell.sourcePrefix));
    if (touched.length === 0) continue;
    const before = versionBefore(shell.versionFile);
    const after = versionAfter(shell.versionFile);
    if (after !== undefined && after !== before) continue;
    problems.push(
      `${shell.name}源码有改动（如 ${touched[0]}），但 ${shell.versionFile} 的版本仍是 ${after ?? "无法解析"}：` +
        `请把该文件的版本号抬一档。注意：抬版本号会让持续集成在合入主分支后自动构建并发布新安装包。`
    );
  }
  return problems;
}

const git = (...args) =>
  execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

/** 比较基线：上一个提交（首个提交或浅克隆取不到时返回原因，调用方据此跳过）。 */
export function resolveBaseline() {
  try {
    git("rev-parse", "--verify", "HEAD");
  } catch {
    return { reason: "当前目录没有可用的 git 历史" };
  }
  try {
    git("rev-parse", "--verify", "HEAD^");
    return { base: "HEAD^" };
  } catch {
    return { reason: "取不到上一个提交（浅克隆或首个提交）" };
  }
}

export function changedSince(base) {
  return git("diff", "--name-only", "--no-renames", base, "HEAD")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 读某个提交里文件的版本号；文件在那个提交里不存在时返回 undefined。 */
export function versionAt(commit, shell) {
  try {
    return shell.readVersion(git("show", `${commit}:${shell.versionFile}`));
  } catch {
    return undefined;
  }
}
