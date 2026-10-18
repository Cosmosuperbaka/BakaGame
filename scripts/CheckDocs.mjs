/**
 * 文档链接与导航校验。
 *
 * 检查范围：仓库根的 AGENTS.md、CLAUDE.md、README.md 与 Agents/ 下的全部 Markdown。
 * 三件事：
 *   1. 相对链接指向的文件必须存在；
 *   2. 带锚点的链接，目标标题必须能生成该锚点（GitHub slug 规则，兼容手写 <a id>）；
 *   3. Agents/ 下每篇文档都必须在 AGENTS.md 的导航表里登记。
 *
 * 纯 Node、无依赖：node scripts/CheckDocs.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const AGENTS_DIR = path.join(ROOT, "Agents");
const ROOT_DOCS = ["AGENTS.md", "CLAUDE.md", "README.md"];
const NAV_OWNER = "AGENTS.md";

/** GitHub 风格标题锚点：小写、去标点、空格转连字符。 */
function slug(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * 子模块路径：内容由各自仓库维护，`actions/checkout` 默认不拉取。
 * 指向子模块内部的链接只校验到子模块根为止，否则 CI 上必然报「文件不存在」，
 * 而本地（子模块已 init）又是绿的——那种门禁没人会信。
 */
const SUBMODULES = (() => {
  const file = path.join(ROOT, ".gitmodules");
  if (!fs.existsSync(file)) return [];
  return [...fs.readFileSync(file, "utf8").matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((match) =>
    match[1].trim().replace(/^\.\//, "")
  );
})();

const insideSubmodule = (rel) => SUBMODULES.some((sub) => rel === sub || rel.startsWith(`${sub}/`));

function collectAnchors(text) {
  const anchors = new Set();
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) anchors.add(slug(heading[1]));
    for (const manual of line.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/gi)) {
      anchors.add(manual[1]);
    }
  }
  return anchors;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function markdownFiles() {
  const files = ROOT_DOCS.filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  for (const name of fs.readdirSync(AGENTS_DIR)) {
    if (name.endsWith(".md")) files.push(path.posix.join("Agents", name));
  }
  return files;
}

const files = markdownFiles();
const anchorsByFile = new Map();
for (const rel of files) anchorsByFile.set(rel, collectAnchors(read(rel)));

const problems = [];
for (const rel of files) {
  const text = read(rel);
  const dir = path.posix.dirname(rel);
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const link = match[1];
    if (/^(?:https?:|mailto:|tel:)/.test(link)) continue;

    const hashIndex = link.indexOf("#");
    const target = hashIndex === -1 ? link : link.slice(0, hashIndex);
    const hash = hashIndex === -1 ? "" : link.slice(hashIndex + 1);

    if (!target) {
      if (hash && !anchorsByFile.get(rel).has(hash)) {
        problems.push(`${rel}: 锚点不存在 #${hash}`);
      }
      continue;
    }

    if (!target.endsWith(".md")) continue;
    const resolved = path.posix.normalize(path.posix.join(dir, target));
    if (insideSubmodule(resolved)) continue;
    if (!fs.existsSync(path.join(ROOT, resolved))) {
      problems.push(`${rel}: 目标文件不存在 ${target}`);
      continue;
    }
    if (hash) {
      const anchors = anchorsByFile.get(resolved);
      if (anchors && !anchors.has(hash)) {
        problems.push(`${rel}: 锚点不存在 ${target}#${hash}`);
      }
    }
  }
}

// 导航覆盖：Agents/ 的每篇文档都要能在 AGENTS.md 里找到链接。
const declared = new Set(files.filter((rel) => rel.startsWith("Agents/")));
const navText = fs.existsSync(path.join(ROOT, NAV_OWNER)) ? read(NAV_OWNER) : "";
for (const rel of declared) {
  const name = path.posix.basename(rel);
  if (!navText.includes(`(${rel})`)) {
    problems.push(`${NAV_OWNER}: 未登记 ${rel}`);
  }
}

if (problems.length) {
  console.error(`发现 ${problems.length} 个文档问题：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`文档校验通过：${files.length} 个文件，链接与导航均有效。`);
