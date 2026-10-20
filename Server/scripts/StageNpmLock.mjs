#!/usr/bin/env node
/**
 * 把 CI 产出的 npm 运行时锁（`server-npm-lock` 制品）打包成「可经 SSH 下发」的形态。
 *
 * 为什么需要（审查 F51）：生产容器入口用 npm 安装运行时依赖，CI 的解析权威却是根
 * pnpm-lock.yaml，两条解析路径并存会让「获验的依赖树」与「线上装的依赖树」不是同一棵。
 * CI 已经用 `Server/scripts/ExportNpmLock.mjs` 产出唯一一枚 npm 口径锁；本脚本**不重新解析
 * 任何东西**，只做三件事：校验那枚锁的口径、算它的 sha256、压成单行 base64 以便随部署
 * 作业下发。因此不存在第二套真相：锁的内容完全由 CI 决定。
 *
 * 下发体积有上限：锁可能到几百 KB，SSH 侧的环境变量不宜无界增长。超限时只下发
 * 「直接依赖的精确版本清单」（pins，字节量级为 KB），部署脚本据此在容器重启后核对
 * 线上实装版本；锁本身则不回退到浮动解析以外的任何来源。
 *
 * 用法：node Server/scripts/StageNpmLock.mjs <lock.json> <outDir> [--max-b64-chars N]
 * 输出：stdout 一行 JSON —— { lockSha256, b64Chars, blob, pins, skipped }
 * 退出码：0 成功（含「过大而跳过 blob」）；1 输入不合口径。
 */

import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 默认上限：单行 base64 的字符数。锁的体积由 CI 决定，这里只限制「愿意经环境变量搬运多少」：
 * 超过上限就不下发锁本体，改为只下发直接依赖的精确版本清单（KB 级），
 * 部署脚本据此在容器重启后核对实装版本，并把「本轮没有锁」写进日志。
 */
export const DEFAULT_MAX_B64_CHARS = 60_000;

const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** 从锁里取出「直接依赖 → 精确版本」；别名包（npm: 协议）不进核对面。 */
export const extractPins = (lock) => {
  const roots = lock?.packages?.[""]?.dependencies;
  if (!roots || typeof roots !== "object") throw new Error('锁缺少 packages[""].dependencies');
  const pins = [];
  const aliases = [];
  for (const [name, value] of Object.entries(roots)) {
    if (typeof value !== "string") throw new Error(`${name} 的版本不是字符串`);
    if (value.startsWith("npm:")) {
      aliases.push(name);
      continue;
    }
    if (!EXACT.test(value))
      throw new Error(
        `${name} 在锁里是区间 "${value}" 而非精确版本：CI 的 ExportNpmLock 应当把它们钉死，检查制品是否与本脚本口径一致`
      );
    pins.push(`${name}@${value}`);
  }
  return { pins, aliases };
};

export const stage = (lockText, maxB64Chars = DEFAULT_MAX_B64_CHARS) => {
  const lock = JSON.parse(lockText);
  if (lock.lockfileVersion !== 3)
    throw new Error(`lockfileVersion=${String(lock.lockfileVersion)}，npm ci 需要 3`);
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (name === "" || typeof entry !== "object" || entry === null) continue;
    if (!entry.resolved) throw new Error(`产物里 ${name} 缺 resolved，npm ci 会拒绝这样的锁`);
  }
  const { pins, aliases } = extractPins(lock);
  if (pins.length === 0) throw new Error("锁里没有任何可核对的直接依赖版本");
  const bytes = Buffer.from(lockText, "utf8");
  const lockSha256 = createHash("sha256").update(bytes).digest("hex");
  const blob = gzipSync(bytes, { level: 9 }).toString("base64");
  return {
    lockSha256,
    b64Chars: blob.length,
    blob: blob.length > maxB64Chars ? null : blob,
    skipped: blob.length > maxB64Chars ? "oversize" : "none",
    pins: pins.join(","),
    aliases,
    jsonBytes: bytes.length,
  };
};

const main = () => {
  const argv = process.argv.slice(2);
  const lockPath = argv[0];
  const outDir = argv[1];
  if (!lockPath || !outDir) {
    console.error(
      "用法：node Server/scripts/StageNpmLock.mjs <lock.json> <outDir> [--max-b64-chars N]"
    );
    process.exit(1);
  }
  const at = argv.indexOf("--max-b64-chars");
  const max = at === -1 ? DEFAULT_MAX_B64_CHARS : Number(argv[at + 1]);
  if (!Number.isFinite(max) || max <= 0) {
    console.error("--max-b64-chars 需要一个正整数");
    process.exit(1);
  }
  const result = stage(readFileSync(lockPath, "utf8"), max);
  mkdirSync(resolve(outDir), { recursive: true });
  writeFileSync(resolve(outDir, "npm-lock.sha256"), `${result.lockSha256}\n`, "utf8");
  writeFileSync(resolve(outDir, "npm-pins.txt"), result.pins, "utf8");
  if (result.blob) writeFileSync(resolve(outDir, "npm-lock.b64"), result.blob, "utf8");
  if (result.aliases.length > 0)
    console.error(`⚠️ 跳过别名依赖（不纳入版本核对）：${result.aliases.join(", ")}`);
  // 摘要不回显 blob 本体：几百 KB 的 base64 进日志只会淹没真正的部署输出。
  const { blob, ...summary } = result;
  console.log(JSON.stringify({ ...summary, staged: blob !== null }));
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
