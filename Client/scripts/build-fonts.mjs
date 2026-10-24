import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "fontkit";
import subsetFont from "subset-font";
import subtlex from "subtlex-ch-chr";

import {
  FAMILIES,
  FONT_LICENSE_SOURCE,
  FONT_RELEASE,
  FONT_SOURCE_DIRNAME,
  FONT_VERSION,
  GENERATED_CSS_NAME,
  GENERATED_FAMILY_DIR,
  GENERATED_MANIFEST_NAME,
  MONO_BASE_RANGES,
  PROJECT_CJK_ROOT,
  SANS_BASE_RANGES,
  buildChunkPlan,
  buildFontCss,
  codepointsFromRanges,
  collectProjectCjk,
  fontFileName,
  gb2312Codepoints,
  hashCodepoints,
  hashText,
  isCjkCodepoint,
  sha256,
} from "./font-subset-plan.mjs";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceCacheDir = path.join(clientDir, ".cache", "fonts", FONT_SOURCE_DIRNAME);
const generatedDir = path.join(clientDir, "src", "assets", "fonts", GENERATED_FAMILY_DIR);
const generatedCssPath = path.join(clientDir, "src", "assets", "fonts", GENERATED_CSS_NAME);
const manifestPath = path.join(clientDir, "src", "assets", "fonts", GENERATED_MANIFEST_NAME);
const licenseSourcePath = path.join(clientDir, FONT_LICENSE_SOURCE);
const publicLicenseDir = path.join(clientDir, "public", "assets", "fonts", GENERATED_FAMILY_DIR);
const inputScriptPaths = [
  fileURLToPath(import.meta.url),
  path.join(clientDir, "scripts", "font-subset-plan.mjs"),
];
const packageJsonPath = path.join(clientDir, "package.json");
const FONT_TOOL_NAMES = ["fontkit", "subset-font", "subtlex-ch-chr"];
const DOWNLOAD_HEADER_TIMEOUT_MS = 30_000;
const DOWNLOAD_STALL_TIMEOUT_MS = 120_000;
const MANIFEST_VERSION = 2;

function fail(message) {
  throw new Error(message);
}

async function computeInputs() {
  const [projectCjk, scriptBuffers, license, packageJsonText] = await Promise.all([
    collectProjectCjk(path.join(clientDir, PROJECT_CJK_ROOT)),
    Promise.all(inputScriptPaths.map((file) => readFile(file))),
    readFile(licenseSourcePath),
    readFile(packageJsonPath, "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonText);
  const toolVersions = Object.fromEntries(
    FONT_TOOL_NAMES.map((name) => [name, packageJson.devDependencies?.[name]])
  );
  const inputHash = sha256(
    JSON.stringify({
      release: { version: FONT_RELEASE.version, files: FONT_RELEASE.files },
      projectCjk,
      scripts: scriptBuffers.map((buffer) => sha256(buffer)),
      license: sha256(license),
      toolVersions,
    })
  );
  return { projectCjk, inputHash };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function downloadWithStallTimeout(url, file, expected) {
  const controller = new AbortController();
  let timer;
  const arm = (milliseconds) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error("下载停滞")), milliseconds);
  };

  try {
    arm(DOWNLOAD_HEADER_TIMEOUT_MS);
    const response = await fetch(url, {
      headers: { "User-Agent": "bakagame-font-builder" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) return Buffer.from(await response.arrayBuffer());

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let nextLog = 5 * 1024 * 1024;
    try {
      while (true) {
        arm(DOWNLOAD_STALL_TIMEOUT_MS);
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        total += value.length;
        if (total >= nextLog) {
          console.log(
            `    ${file} ${(total / 1024 / 1024).toFixed(1)}/${(expected.bytes / 1024 / 1024).toFixed(1)} MB`
          );
          nextLog += 5 * 1024 * 1024;
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
  }
}

async function downloadFont(file, expected) {
  const attempts = [];
  for (const baseUrl of FONT_RELEASE.baseUrls) {
    const url = new URL(file, baseUrl);
    console.log(`  下载 ${file}（${(expected.bytes / 1024 / 1024).toFixed(1)} MB）`);
    try {
      const buffer = await downloadWithStallTimeout(url, file, expected);
      if (buffer.length !== expected.bytes) {
        throw new Error(`长度 ${buffer.length}B ≠ ${expected.bytes}B`);
      }
      const actual = sha256(buffer);
      if (actual !== expected.sha256) throw new Error(`SHA-256 不符（实际 ${actual}）`);
      return buffer;
    } catch (error) {
      attempts.push(`${url}：${error.message}`);
      console.warn(`  该源失败，继续尝试下一个：${error.message}`);
    }
  }
  fail(
    `下载字体失败：${file}\n${attempts.map((attempt) => `  - ${attempt}`).join("\n")}\n可检查网络后重试，或把官方文件放到 ${sourceCacheDir}`
  );
}

/**
 * 上游字体只放进可清理的本地缓存，不进 Git。每次命中都重新核对长度与 SHA-256，
 * 缓存被截断或替换时会重新下载；GitHub 不可达且缓存为空时直接失败，不静默使用未知字体。
 */
async function loadSourceFonts() {
  await mkdir(sourceCacheDir, { recursive: true });
  const entries = await mapLimit(Object.keys(FONT_RELEASE.files), 2, async (file) => {
    const expected = FONT_RELEASE.files[file];
    const target = path.join(sourceCacheDir, file);
    const cached = await readFile(target).catch(() => null);
    if (cached && cached.length === expected.bytes && sha256(cached) === expected.sha256) {
      return [file, cached];
    }

    const buffer = await downloadFont(file, expected);
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, buffer);
    await rename(temporary, target);
    return [file, buffer];
  });
  return new Map(entries);
}

function intersect(sets) {
  const [first, ...rest] = sets;
  return new Set([...first].filter((codepoint) => rest.every((set) => set.has(codepoint))));
}

function parseSources(buffers) {
  const sources = new Map();
  for (const family of FAMILIES) {
    for (const { weight, file } of family.weights) {
      const buffer = buffers.get(file);
      const font = create(buffer);
      const familyName = String(font.familyName).replace(/\s+(Light|Medium|Regular)$/, "");
      if (familyName !== family.family) {
        fail(`${file} 的字体族是 "${font.familyName}"，预期 "${family.family}"`);
      }
      if (!String(font.version).includes(FONT_VERSION)) {
        fail(`${file} 的版本是 "${font.version}"，预期包含 ${FONT_VERSION}`);
      }
      if (font["OS/2"]?.usWeightClass !== weight) {
        fail(`${file} 的字重是 ${font["OS/2"]?.usWeightClass}，预期 ${weight}`);
      }
      sources.set(file, { buffer, characters: new Set(font.characterSet) });
    }
  }
  return sources;
}

function planFont(sources, projectCjk) {
  const sansSets = FAMILIES.find((family) => family.id === "sans").weights.map(
    ({ file }) => sources.get(file).characters
  );
  const monoSets = FAMILIES.find((family) => family.id === "mono").weights.map(
    ({ file }) => sources.get(file).characters
  );
  const sansCharacters = intersect(sansSets);
  const monoCharacters = intersect(monoSets);

  const frequencyOrder = subtlex.data
    .map((entry) => entry.Character.codePointAt(0))
    .filter((codepoint) => isCjkCodepoint(codepoint));
  const cjk = [...new Set([...gb2312Codepoints(), ...frequencyOrder, ...projectCjk])]
    .filter((codepoint) => isCjkCodepoint(codepoint) && sansCharacters.has(codepoint))
    .sort((left, right) => left - right);
  const sansBase = codepointsFromRanges(SANS_BASE_RANGES).filter((codepoint) =>
    sansCharacters.has(codepoint)
  );
  const monoBase = codepointsFromRanges(MONO_BASE_RANGES).filter((codepoint) =>
    monoCharacters.has(codepoint)
  );

  return {
    sansChunks: buildChunkPlan({
      baseCodepoints: sansBase,
      cjkCodepoints: cjk,
      frequencyOrder,
    }),
    monoChunks: buildChunkPlan({ baseCodepoints: monoBase }),
    counts: {
      gb2312: gb2312Codepoints().length,
      subtlex: frequencyOrder.length,
      project: projectCjk.length,
      sansCjk: cjk.length,
      sansBase: sansBase.length,
      monoBase: monoBase.length,
    },
    projectCjkSha256: hashCodepoints(
      projectCjk.filter((codepoint) => sansCharacters.has(codepoint))
    ),
  };
}

function chunkCounts(chunks) {
  const counts = { base: 0, common: 0, rest: 0 };
  for (const chunk of chunks) counts[chunk.kind] += 1;
  return counts;
}

function manifestFrom({ inputHash, sources, plan, css, files }) {
  return {
    version: MANIFEST_VERSION,
    inputHash,
    fontVersion: FONT_VERSION,
    sourceFiles: Object.fromEntries(
      [...sources.entries()].map(([file, source]) => [file, sha256(source.buffer)])
    ),
    projectCjkSha256: plan.projectCjkSha256,
    cssSha256: hashText(css),
    counts: plan.counts,
    chunks: {
      sans: chunkCounts(plan.sansChunks),
      mono: chunkCounts(plan.monoChunks),
    },
    files: Object.fromEntries(files.map((file) => [file.name, file.sha256])),
    fileBytes: Object.fromEntries(files.map((file) => [file.name, file.data.length])),
  };
}

function planSummary(plan, files) {
  const totalBytes = files.reduce((total, file) => total + file.data.length, 0);
  return [
    `基础字符   sans ${plan.counts.sansBase} · mono ${plan.counts.monoBase}`,
    `CJK 覆盖   ${plan.counts.sansCjk}（GB2312 ${plan.counts.gb2312} ∪ 词频 ${plan.counts.subtlex} ∪ 项目 ${plan.counts.project}）`,
    `分片       sans ${plan.sansChunks.length} 片 × ${FAMILIES[0].weights.length} 字重 · mono ${plan.monoChunks.length} 片 × ${FAMILIES[1].weights.length} 字重`,
    `产物       ${files.length} 个 woff2 / ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
  ];
}

async function validateGenerated(inputHash) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
  if (manifest.version !== MANIFEST_VERSION || manifest.inputHash !== inputHash) return null;
  if (manifest.fontVersion !== FONT_VERSION) return null;

  const css = await readFile(generatedCssPath, "utf8").catch(() => null);
  if (!css || hashText(css) !== manifest.cssSha256) return null;

  const entries = Object.entries(manifest.files ?? {});
  if (entries.length === 0) return null;
  for (const [name, expected] of entries) {
    if (!name.endsWith(".woff2")) return null;
    const data = await readFile(path.join(generatedDir, name)).catch(() => null);
    if (!data || data.length !== manifest.fileBytes?.[name] || sha256(data) !== expected) {
      return null;
    }
  }
  return { manifest, css };
}

async function publishLicense() {
  await mkdir(publicLicenseDir, { recursive: true });
  await copyFile(licenseSourcePath, path.join(publicLicenseDir, "OFL.txt"));
}

export async function ensureFonts({ force = false } = {}) {
  const { projectCjk, inputHash } = await computeInputs();
  if (!force) {
    const cached = await validateGenerated(inputHash);
    if (cached) {
      await publishLicense();
      console.log(`字体子集缓存命中：${Object.keys(cached.manifest.files).length} 个 woff2`);
      return cached;
    }
  }

  const buffers = await loadSourceFonts();
  const sources = parseSources(buffers);
  const plan = planFont(sources, projectCjk);
  const css = buildFontCss({ sansChunks: plan.sansChunks, monoChunks: plan.monoChunks });

  const jobs = [];
  for (const family of FAMILIES) {
    const chunks = family.id === "sans" ? plan.sansChunks : plan.monoChunks;
    for (const { weight, file } of family.weights) {
      for (const chunk of chunks) {
        jobs.push({ familyId: family.id, weight, chunk, source: sources.get(file) });
      }
    }
  }

  let completed = 0;
  const files = await mapLimit(jobs, 3, async (job) => {
    const text = job.chunk.cps.map((codepoint) => String.fromCodePoint(codepoint)).join("");
    let data;
    try {
      data = await subsetFont(job.source.buffer, text, { targetFormat: "woff2" });
    } catch (error) {
      fail(
        `子集化失败（${job.familyId} ${job.weight} 第 ${job.chunk.index} 片）：${error.message}`
      );
    }
    completed += 1;
    if (completed % 12 === 0 || completed === jobs.length) {
      console.log(`  子集化 ${completed}/${jobs.length}`);
    }
    return {
      name: fontFileName(job.familyId, job.weight, job.chunk.index),
      data,
      sha256: sha256(data),
    };
  });

  const manifest = manifestFrom({ inputHash, sources, plan, css, files });

  await rm(generatedDir, { recursive: true, force: true });
  await mkdir(generatedDir, { recursive: true });
  await Promise.all(files.map((file) => writeFile(path.join(generatedDir, file.name), file.data)));
  await writeFile(generatedCssPath, css);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await publishLicense();

  console.log(`字体子集完成（LXGW WenKai v${FONT_VERSION}）`);
  for (const line of planSummary(plan, files)) console.log(`  ${line}`);
  console.log(`  CSS        ${(Buffer.byteLength(css) / 1024).toFixed(1)} KB`);
  return { manifest, css };
}

export async function checkFonts() {
  const { inputHash } = await computeInputs();
  const cached = await validateGenerated(inputHash);
  if (!cached) {
    fail("字体子集缺失或已过期，请运行 pnpm --filter client fonts:build 重新生成");
  }
  const license = await readFile(path.join(publicLicenseDir, "OFL.txt")).catch(() => null);
  if (!license) fail("字体许可公开副本缺失，请重新生成字体子集");
  console.log(
    `字体子集校验通过：${Object.keys(cached.manifest.files).length} 个 woff2，CJK ${cached.manifest.counts.sansCjk} 字`
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const run = process.argv.includes("--check")
    ? checkFonts
    : () => ensureFonts({ force: process.argv.includes("--force") });
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
