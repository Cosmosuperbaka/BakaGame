import { gzipSync } from "node:zlib";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 首屏产物的包体上限。取值不是性能目标，而是**上一次有记录的实测值留出余量**：
 * F43 的审查结论就是资源按「能用」入库、没人记账——单个 CSS 长到 102KB gz、
 * 218 个 woff2、路由分片 135KB gz 都没人发现。这条门禁只挡累积。
 * 有意识地做小某项时连同数字一起改小，做大了就在提交说明里写清理由与实测幅度。
 */
export const BUDGETS = {
  /** 渲染阻塞样式表：实测 129,518B gz；全量 cmap 分片带来 214 条 @font-face，未命中分片只影响 CSS 规则、不下载字体。 */
  entryCssGzBytes: 135_000,
  /** 入口 HTML 直取与 modulepreload 的 JS 图：实测约 311.3KB gz（展示版本号改构建期注入后 −5KB）。 */
  entryJsGraphGzBytes: 321_000,
  /** 单个路由分片：实测最大 SonGuessrRoomPage 约 135.1KB gz。 */
  largestChunkGzBytes: 139_000,
  /** 入口样式表里的 @font-face 条数：实测 214 条（全量 sans 93、mono 9、衬线 101、其余拉丁 11）。 */
  entryFontFaceRules: 224,
  /** 产物里的 woff2 个数与总字节：实测 217 个 / 38,413,228B；全量字符集分片，未命中分片不会加载。 */
  emittedFontFiles: 220,
  emittedFontBytes: 42_000_000,
  /** 按显示尺寸出档的资源（见 prepare-public-webp 的 DISPLAY_MAX_HEIGHT_PX）。 */
  logoBytes: 220_000,
  faviconBytes: 4_000,
};

const ASSET_PATTERN = /\.(?:css|js|woff2?|webp)$/;
const assetName = (href) => (href ?? "").split("?")[0].replace(/^\/assets\//, "");
const hrefOf = (tag) => (tag.match(/(?:href|src)=["']([^"']+)["']/i) || [])[1];

/**
 * `media="print"` 的样式表不挡首屏渲染；其余一律按阻塞计（静态分析无法判定
 * 媒体查询是否命中，宁可多算，门禁才不会漏）。
 */
const blockingStylesheets = (tags) =>
  tags.filter((t) => /rel=["']stylesheet["']/i.test(t) && !/media=["']print["']/i.test(t));

/**
 * 纯函数：吃 index.html 文本与 `assets/` 下的文件字节，吐出口径一致的度量。
 * 与构建解耦是为了让「超限必须报错」这条能被确定性地测到，不必每次真构建。
 */
export function analyze({ htmlText, files, budgets = BUDGETS }) {
  const gzOf = (name) => {
    const bytes = files.get(name);
    if (!bytes) throw new Error(`入口 HTML 引用的产物不存在：assets/${name}`);
    return gzipSync(bytes).length;
  };
  const tags = [...htmlText.matchAll(/<(?:link|script)\b[^>]*>/gi)].map((m) => m[0]);
  const css = blockingStylesheets(tags).map((t) => assetName(hrefOf(t)));
  const js = tags
    .filter((t) => /type=["']module["']/i.test(t) || /rel=["']modulepreload["']/i.test(t))
    .map((t) => assetName(hrefOf(t)));

  const chunks = [...files.keys()]
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, gz: gzOf(name) }))
    .sort((a, b) => b.gz - a.gz);
  const fonts = [...files.entries()].filter(([name]) => /\.woff2?$/.test(name));

  const metrics = {
    entryCssGzBytes: css.reduce((total, name) => total + gzOf(name), 0),
    entryJsGraphGzBytes: js.reduce((total, name) => total + gzOf(name), 0),
    largestChunkGzBytes: chunks[0]?.gz ?? 0,
    largestChunkName: chunks[0]?.name ?? null,
    entryFontFaceRules: css.reduce(
      (total, name) =>
        total +
        (
          files
            .get(name)
            .toString("utf8")
            .match(/@font-face\s*\{/g) || []
        ).length,
      0
    ),
    emittedFontFiles: fonts.length,
    emittedFontBytes: fonts.reduce((total, [, bytes]) => total + bytes.length, 0),
    logoBytes: files.get("logo.webp")?.length ?? 0,
    faviconBytes: files.get("favicon.webp")?.length ?? 0,
  };

  return { metrics, violations: evaluate(metrics, budgets), budgets };
}

export function evaluate(metrics, budgets) {
  const violations = [];
  for (const [key, limit] of Object.entries(budgets)) {
    const value = metrics[key];
    // 度量与预算表必须同键：漏掉一项就等于那条预算被静默撤掉。
    if (typeof value !== "number") throw new Error(`度量缺少 ${key}，门禁口径与预算表不一致`);
    if (value > limit) violations.push({ key, value, limit });
  }
  return violations;
}

export async function readDist(distDir) {
  const htmlText = await readFile(path.join(distDir, "index.html"), "utf8");
  const assetDir = path.join(distDir, "assets");
  const names = (await readdir(assetDir)).filter((name) => ASSET_PATTERN.test(name));
  const files = new Map();
  for (const name of names) files.set(name, await readFile(path.join(assetDir, name)));
  return { htmlText, files };
}

const format = (n) => n.toLocaleString("en-US");

export async function checkFirstScreenBudget(distDir = path.join(clientDir, "dist")) {
  const { metrics, violations } = analyze(await readDist(distDir));
  const lines = [
    `入口阻塞 CSS  ${format(metrics.entryCssGzBytes)} B gz · 上限 ${format(BUDGETS.entryCssGzBytes)}`,
    `入口 JS 图    ${format(metrics.entryJsGraphGzBytes)} B gz · 上限 ${format(BUDGETS.entryJsGraphGzBytes)}`,
    `最大分片      ${format(metrics.largestChunkGzBytes)} B gz（${metrics.largestChunkName}）· 上限 ${format(BUDGETS.largestChunkGzBytes)}`,
    `@font-face    ${metrics.entryFontFaceRules} 条 · 上限 ${BUDGETS.entryFontFaceRules}`,
    `woff2         ${metrics.emittedFontFiles} 个 / ${format(metrics.emittedFontBytes)} B · 上限 ${BUDGETS.emittedFontFiles} 个 / ${format(BUDGETS.emittedFontBytes)}`,
    `出档资源      logo ${format(metrics.logoBytes)} B · 上限 ${format(BUDGETS.logoBytes)}；favicon ${format(metrics.faviconBytes)} B · 上限 ${format(BUDGETS.faviconBytes)}`,
  ];
  return { metrics, violations, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const { violations, lines } = await checkFirstScreenBudget(
    path.resolve(arg("dist", path.join(clientDir, "dist")))
  );
  console.log(`首屏产物预算（dist 实测，gzip 默认级别）\n${lines.join("\n")}`);
  if (violations.length) {
    console.error(
      `包体门禁失败：\n${violations
        .map((v) => `  ${v.key}: 实测 ${format(v.value)} > 上限 ${format(v.limit)}`)
        .join("\n")}`
    );
    process.exitCode = 1;
  } else {
    console.log("包体门禁通过。");
  }
}
