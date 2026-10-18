#!/usr/bin/env node
// 打包前处理（Mobile → Client 单向只读，绝不写 Client/**）：
// 1. 把 Client 构建产物复制到 Mobile/dist-web；
// 2. 注入 baka-bridge.js（classic、置于所有 module 脚本之前，保证 window.__BAKA_CHANNEL__ 先于应用代码就绪）；
// 3. 把 Mobile/package.json 的 version 写入桥接层，并同步到 android 工程的 versionName（单一版本源）。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, "..");
const clientDist = path.resolve(mobile, "../Client/dist");
const distWeb = path.resolve(mobile, "dist-web");

if (!fs.existsSync(path.join(clientDist, "index.html"))) {
  console.error("[prepare-web] 未找到 Client/dist，请先在仓库根执行：pnpm --filter client build");
  process.exit(1);
}

fs.rmSync(distWeb, { recursive: true, force: true });
fs.cpSync(clientDist, distWeb, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.resolve(mobile, "package.json"), "utf8"));

// 版本号占位符与桥接脚本落位
const bridgeSrc = fs
  .readFileSync(path.resolve(mobile, "bridge/baka-bridge.js"), "utf8")
  .replaceAll("__BAKA_CLIENT_VERSION__", pkg.version);
fs.writeFileSync(path.join(distWeb, "baka-bridge.js"), bridgeSrc);

// 注入 <script>：放在 head 内所有 module/远端脚本之前
const indexPath = path.join(distWeb, "index.html");
let html = fs.readFileSync(indexPath, "utf8");
const tag = '<script src="baka-bridge.js"></script>';
if (!html.includes(tag)) {
  if (!/<head[^>]*>/i.test(html)) {
    console.error("[prepare-web] index.html 缺少 <head>，无法注入桥接脚本");
    process.exit(1);
  }
  html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  fs.writeFileSync(indexPath, html);
}

// 同步 versionName 到 app/build.gradle（android 的 build.gradle 是 Mobile 自己的文件，允许写）
const buildGradle = path.resolve(mobile, "android/app/build.gradle");
let gradle = fs.readFileSync(buildGradle, "utf8");
gradle = gradle.replace(/versionName "[^"]*"/, `versionName "${pkg.version}"`);
fs.writeFileSync(buildGradle, gradle);

console.log(`[prepare-web] dist-web 就绪（版本 ${pkg.version}）。接下来执行 pnpm run sync。`);
