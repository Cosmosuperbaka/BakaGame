import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import WebPMux from "node-webpmux";
import sharp from "sharp";
import UPNG from "upng-js";

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

const toWebPath = (...parts) =>
  "/" + parts.filter(Boolean).join("/").replace(/\\+/g, "/").replace(/^\/+/, "");

/**
 * 按显示尺寸出档：键是相对 `public/` 的源路径，值是输出高度上限（像素）。
 * 只列「源图是设计原始尺寸、页面显示尺寸远小于它」的资源，取值按最大显示高度 × DPR：
 * - `/assets/logo.gif` 落地页 h1 里的动画标，最高档 `md:h-16`（64px）×DSF 2，
 *   移动端 `h-12`（48px）×DSF 3 ⇒ 144。
 * - `/assets/favicon.png` 只用作浏览器标签页图标（≤32px ×DSF 2）⇒ 64。
 *
 * 只缩不放（`withoutEnlargement`）。分享图 `/og/*.jpg` 由 `public/assets` 下的原始文件
 * 另转一份，不读这里的产物，所以出档不会动到分享卡片的清晰度。
 */
const DISPLAY_MAX_HEIGHT_PX = {
  "/assets/logo.gif": 144,
  "/assets/favicon.png": 64,
};

async function convertDirectory(source, output, relativeDir = "", assetMap = {}, encode) {
  await mkdir(output, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  const outputNames = new Set();

  for (const entry of entries) {
    const extension = path.extname(entry.name).toLowerCase();
    const targetName =
      entry.isFile() && imageExtensions.has(extension) ? outputName(entry.name) : entry.name;
    const normalizedTarget = targetName.toLocaleLowerCase("en-US");
    if (outputNames.has(normalizedTarget)) {
      throw new Error(`公共资源转换后发生重名: ${path.join(source, targetName)}`);
    }
    outputNames.add(normalizedTarget);
  }

  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = path.join(source, entry.name);
      const childRelative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await convertDirectory(
          sourcePath,
          path.join(output, entry.name),
          childRelative,
          assetMap,
          encode
        );
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
      await encode(sourcePath, targetPath, DISPLAY_MAX_HEIGHT_PX[toWebPath(childRelative)]);

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
    })
  );
}

async function isApng(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".png" && ext !== ".apng") return false;
  try {
    const data = await readFile(filePath);
    return data.includes(Buffer.from("acTL"));
  } catch {
    return false;
  }
}

async function encodeApngToWebp(source, target, maxHeight) {
  const buf = await readFile(source);
  const apng = UPNG.decode(buf);
  const rgbaFrames = UPNG.toRGBA8(apng);
  const delays = apng.frames.map((f) => f.delay);
  const scale = maxHeight && apng.height > maxHeight ? maxHeight / apng.height : 1;
  const outWidth = Math.round(apng.width * scale);
  const outHeight = Math.round(apng.height * scale);

  const frames = [];
  for (let i = 0; i < rgbaFrames.length; i++) {
    const webpBuf = await sharp(Buffer.from(rgbaFrames[i]), {
      raw: { width: apng.width, height: apng.height, channels: 4 },
    })
      .resize({ width: outWidth, height: outHeight, fit: "fill" })
      .webp({ quality: 82, alphaQuality: 90, effort: 4 })
      .toBuffer();

    const frame = await WebPMux.Image.generateFrame({
      buffer: webpBuf,
      delay: delays[i] || 50,
      blend: false,
      dispose: true,
    });
    frames.push(frame);
  }

  const outputBuffer = await WebPMux.Image.save(null, {
    frames,
    width: outWidth,
    height: outHeight,
    loops: 0,
    bgColor: [0, 0, 0, 0],
  });
  await writeFile(target, outputBuffer);
}

function createEncoder(concurrency) {
  let active = 0;
  const waiting = [];
  return async (source, target, maxHeight) => {
    if (active >= concurrency) await new Promise((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      if (await isApng(source)) {
        await encodeApngToWebp(source, target, maxHeight);
      } else {
        const image = sharp(source, { animated: true });
        if (maxHeight) image.resize({ height: maxHeight, withoutEnlargement: true });
        await image.webp({ quality: 82, alphaQuality: 90, effort: 4 }).toFile(target);
      }
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

export async function preparePublicWebp() {
  await rm(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const assetMap = {};
  // 所有目录共用一个编码队列，避免递归 Promise.all 同时耗尽原生线程。
  const encode = createEncoder(4);
  await convertDirectory(sourceDir, outputDir, "", assetMap, encode);
  return { publicDir: outputDir, assetMap };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await preparePublicWebp();
}
