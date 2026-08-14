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
  const extension = path.extname(normalizedPath).toLowerCase();
  const digest = createHash("sha256")
    .update(normalizedPath, "utf8")
    .update("\0", "utf8")
    .update(contents)
    .digest("hex")
    .slice(0, 24);
  return `/stickers/${digest}${extension}`;
}

async function copyStickerAssets(source, relativeDirectory = "") {
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const sourcePath = path.join(source, entry.name);
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      await copyStickerAssets(sourcePath, relativePath);
      return;
    }
    if (!entry.isFile() || !stickerExtensions.has(path.extname(entry.name).toLowerCase())) return;

    const contents = await readFile(sourcePath);
    const assetUrl = stickerAssetUrl(relativePath, contents);
    const targetPath = path.join(outputDir, assetUrl.slice(1));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath);
  }));
}

async function convertDirectory(source, output) {
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
    if (entry.isDirectory()) {
      await convertDirectory(sourcePath, path.join(output, entry.name));
      return;
    }
    if (!entry.isFile()) return;

    const extension = path.extname(entry.name).toLowerCase();
    if (!imageExtensions.has(extension)) {
      await cp(sourcePath, path.join(output, entry.name));
      return;
    }

    await sharp(sourcePath, { animated: true })
      .webp({ quality: 82, alphaQuality: 90, effort: 4 })
      .toFile(path.join(output, outputName(entry.name)));
  }));
}

export async function preparePublicWebp() {
  await rm(outputDir, { recursive: true, force: true });
  await Promise.all([
    convertDirectory(sourceDir, outputDir),
    copyStickerAssets(path.join(sourceDir, "emojis")),
  ]);
  return outputDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await preparePublicWebp();
}
