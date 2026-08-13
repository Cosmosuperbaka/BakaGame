import { cp, mkdir, readdir, rm } from "node:fs/promises";
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

const outputName = (name) => `${path.basename(name, path.extname(name))}.webp`;

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
  await convertDirectory(sourceDir, outputDir);
  return outputDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await preparePublicWebp();
}
