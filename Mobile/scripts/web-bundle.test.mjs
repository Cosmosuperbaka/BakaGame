import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

/**
 * 热更新包的 zip 写入器是手写的：壳端的 ZipInputStream 会校验每个条目的 CRC，
 * 写错一位整个包都装不上。这里把脚本拷进临时目录树、喂一份小的 dist-web 跑一遍，
 * 再用测试自己的 CRC 实现独立解析产物，不依赖被测脚本用的是哪种 CRC 实现。
 */
const here = path.dirname(fileURLToPath(import.meta.url));

const referenceCrc = (buffer) => {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
};

/** 读中央目录：返回每个条目的名字、声明的 CRC 与解压后的内容。 */
const readZip = (zip) => {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const offset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const localNameLength = zip.readUInt16LE(offset + 26);
    const dataStart = offset + 30 + localNameLength + zip.readUInt16LE(offset + 28);
    const payload = zip.subarray(dataStart, dataStart + compressedSize);
    entries.push({
      name,
      crc,
      content: method === 8 ? inflateRawSync(payload) : Buffer.from(payload),
    });
    cursor += 46 + nameLength;
  }
  return entries;
};

const buildBundle = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baka-web-bundle-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(here, "web-bundle.mjs"),
      path.join(root, "scripts", "web-bundle.mjs")
    );
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, "dist-web", name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    const run = spawnSync(process.execPath, [path.join(root, "scripts", "web-bundle.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const out = path.join(root, "build", "web-bundle");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(out, "BakaGame-web-latest.json"), "utf8")
    );
    const zip = fs.readFileSync(path.join(out, manifest.file));
    return { manifest, zip };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const html = '<!doctype html><meta name="bakagame-build" content="abc1234">';
const random = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 2654435761) >>> 24));

test("热更新包：每个条目的 CRC 正确、内容可还原、清单哈希对得上", () => {
  const files = {
    "index.html": html,
    "assets/app.js": "console.log('hello');\n".repeat(200),
    "assets/blob.bin": random,
    "empty.txt": "",
  };
  const { manifest, zip } = buildBundle(files);

  const entries = readZip(zip);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), Object.keys(files).sort());
  for (const entry of entries) {
    assert.equal(entry.crc, referenceCrc(entry.content), `${entry.name} 的 CRC 不对`);
    assert.deepEqual(entry.content, Buffer.from(files[entry.name]));
  }
  assert.equal(manifest.sha256, createHash("sha256").update(zip).digest("hex"));
  assert.equal(manifest.build, "abc1234");
  assert.equal(manifest.minShellVersion, "1.2.3");
});

test("热更新包：同一份输入两次打包得到同一个 sha256", () => {
  const files = { "index.html": html, "a.js": "x".repeat(1000) };
  assert.equal(buildBundle(files).manifest.sha256, buildBundle(files).manifest.sha256);
});
