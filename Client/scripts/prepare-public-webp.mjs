import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(scriptDir, "..");
const sourceDir = path.join(clientDir, "public");
const outputDir = path.join(clientDir, ".generated-public");
const imageExtensions = new Set([
  ".apng",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);
const stickerExtensions = new Set([".apng", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

const outputName = (name) => `${path.basename(name, path.extname(name))}.webp`;

export function stickerAssetUrl(relativePath, contents) {
  const normalizedPath = relativePath.split(path.sep).join("/");
  const digest = createHash("sha256")
    .update(normalizedPath, "utf8")
    .update("\0", "utf8")
    .update(contents)
    .digest("hex")
    .slice(0, 24);
  return `/stickers/${digest}.webp`;
}

const toWebPath = (...parts) => "/" + parts.filter(Boolean).join("/").replace(/\\+/g, "/").replace(/^\/+/, "");

async function convertDirectory(source, output, relativeDir = "", assetMap = {}, encode) {
  await mkdir(output, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  const outputNames = new Set();

  for (const entry of entries) {
    const extension = path.extname(entry.name).toLowerCase();
    const targetName = entry.isFile() && imageExtensions.has(extension)
      ? outputName(entry.name)
      : entry.name;
    const normalizedTarget = targetName.toLocaleLowerCase("en-US");
    if (outputNames.has(normalizedTarget)) {
      throw new Error(`公共资源转换后发生重名: ${path.join(source, targetName)}`);
    }
    outputNames.add(normalizedTarget);
  }

  await Promise.all(entries.map(async (entry) => {
    const sourcePath = path.join(source, entry.name);
    const childRelative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      await convertDirectory(sourcePath, path.join(output, entry.name), childRelative, assetMap, encode);
      return;
    }
    if (!entry.isFile()) return;

    const extension = path.extname(entry.name).toLowerCase();
    if (!imageExtensions.has(extension)) {
      await cp(sourcePath, path.join(output, entry.name));
      return;
    }

    if (extension !== ".webp") {
      const sourceWebPath = toWebPath(relativeDir, entry.name);
      const targetWebPath = toWebPath(relativeDir, outputName(entry.name));
      assetMap[sourceWebPath] = targetWebPath;
    }

    const targetPath = path.join(output, outputName(entry.name));
    await encode(sourcePath, targetPath);

    // 保留公共路径与哈希路径，复用同一份编码结果（包括动画帧）。
    const parts = childRelative.split(path.sep);
    if (parts[0] === "emojis" && stickerExtensions.has(extension)) {
      const relativePath = parts.slice(1).join("/");
      const assetUrl = stickerAssetUrl(relativePath, await readFile(sourcePath));
      const stickerPath = path.join(outputDir, assetUrl.slice(1));
      await mkdir(path.dirname(stickerPath), { recursive: true });
      await cp(targetPath, stickerPath);
      if (extension !== ".webp") {
        assetMap[assetUrl.replace(/\.webp$/, extension)] = assetUrl;
      }
    }
  }));
}

function createEncoder(concurrency) {
  let active = 0;
  const waiting = [];
  return async (source, target) => {
    if (active >= concurrency) await new Promise((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      await sharp(source, { animated: true })
        .webp({ quality: 82, alphaQuality: 90, effort: 4 })
        .toFile(target);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

export async function preparePublicWebp() {
  await rm(outputDir, { recursive: true, force: true });
  const assetMap = {};
  // 所有目录共用一个编码队列，避免递归 Promise.all 同时耗尽原生线程。
  const encode = createEncoder(4);
  await convertDirectory(sourceDir, outputDir, "", assetMap, encode);
  return { publicDir: outputDir, assetMap };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await preparePublicWebp();
}
