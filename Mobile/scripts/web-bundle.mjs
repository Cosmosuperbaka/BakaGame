#!/usr/bin/env node
// 移动壳 Web 资源热更新包：把 prepare-web 产出的 dist-web 打成 zip，并生成服务端读取的清单。
//
// 只写 Mobile/build/web-bundle/，不碰 dist-web 与 Client/**。CI 在 prepare-web 之后、APK 构建
// 之前跑这一步；产物随 client-publish 推到对象存储，壳按清单里的 build 与 sha256 决定是否下载。
//
// 不引第三方打包库：zip 容器格式固定，自己写反而能保证条目顺序、时间戳与压缩方式稳定，
// 同一份 dist-web 每次产出的 sha256 一致，排查时不会因为“重新打了一次包”而换哈希。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, "..");
const repo = path.resolve(mobile, "..");
const distWeb = path.join(mobile, "dist-web");
const outDir = path.join(mobile, "build", "web-bundle");

const fail = (message) => {
  console.error(`[web-bundle] ${message}`);
  process.exit(1);
};

const readBuild = () => {
  const indexPath = path.join(distWeb, "index.html");
  if (!fs.existsSync(indexPath)) fail("未找到 dist-web/index.html，请先执行 npm run prepare-web");
  const html = fs.readFileSync(indexPath, "utf8");
  const tag = html.match(/<meta[^>]*name=["']bakagame-build["'][^>]*>/i)?.[0] ?? "";
  const build = tag.match(/content=["']([^"']+)["']/i)?.[1]?.trim() ?? "";
  if (!build || build === "dev") {
    fail(`index.html 的 bakagame-build 不可用于热更新（读到 "${build}"）`);
  }
  if (!/^(?!.*\.\.)(?!\.$)[A-Za-z0-9._-]{1,64}$/.test(build)) {
    fail(`构建标记含不安全字符：${build}`);
  }
  return build;
};

const readShellVersion = () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(mobile, "package.json"), "utf8"));
  if (!/^\d+(\.\d+){0,3}$/.test(pkg.version))
    fail(`Mobile/package.json 版本不合法：${pkg.version}`);
  return pkg.version;
};

/** 展示用版本号取更新日志里的最大版本；日志顺序不参与判断。 */
const readLatestChangelogVersion = () => {
  const file = path.join(repo, "Client", "src", "data", "changelog.json");
  try {
    const entries = JSON.parse(fs.readFileSync(file, "utf8")).entries ?? [];
    const compare = (a, b) => {
      const left = String(a)
        .split(".")
        .map((part) => Number.parseInt(part, 10) || 0);
      const right = String(b)
        .split(".")
        .map((part) => Number.parseInt(part, 10) || 0);
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const diff = (left[index] ?? 0) - (right[index] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    };
    return entries
      .map((entry) => entry.version)
      .filter((version) => typeof version === "string")
      .reduce(
        (latest, version) => (latest === "" || compare(version, latest) > 0 ? version : latest),
        ""
      );
  } catch {
    return "";
  }
};

/** 固定 DOS 时间（2000-01-01 00:00）与权限，保证同一份输入产出同一个 zip。 */
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const collectFiles = (root) => {
  const out = [];
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile())
        out.push({ full, name: path.relative(root, full).replaceAll("\\", "/") });
    }
  };
  walk(root);
  return out;
};

/**
 * 最小 ZIP 写入器：deflate 能变小就压缩，否则原样存（woff2 等已压缩资源）。
 * 只支持单层可读的标准结构，够热更新包用；不支持 zip64（产物远小于 4 GB）。
 */
const buildZip = (root) => {
  const files = collectFiles(root);
  if (files.length === 0) fail("dist-web 为空，拒绝生成空包");
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = fs.readFileSync(file.full);
    const compressed = deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 文件名 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return { zip: Buffer.concat([...locals, centralBuffer, end]), count: files.length };
};

const build = readBuild();
const shellVersion = readShellVersion();
const zipName = `BakaGame-web-${build}.zip`;
const changelogVersion = readLatestChangelogVersion();

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const { zip, count } = buildZip(distWeb);
fs.writeFileSync(path.join(outDir, zipName), zip);

const manifest = {
  build,
  ...(changelogVersion ? { version: changelogVersion } : {}),
  file: zipName,
  sha256: createHash("sha256").update(zip).digest("hex"),
  sizeBytes: zip.length,
  minShellVersion: shellVersion,
  publishedAt: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(outDir, "BakaGame-web-latest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);

console.log(
  `[web-bundle] ${zipName}（${(zip.length / 1024 / 1024).toFixed(1)} MB，${count} 个文件）` +
    `\n[web-bundle] build=${build} minShellVersion=${shellVersion} sha256=${manifest.sha256}`
);
