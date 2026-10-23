/**
 * 文档链接、导航与冻结校验。
 *
 * 检查范围：仓库根的 AGENTS.md、CLAUDE.md、README.md，Client/AGENTS.md、Server/AGENTS.md，
 * 以及 Agents/、Client/docs/、Server/docs/ 下的全部 Markdown。
 * 四件事：
 *   1. 相对链接指向的文件必须存在；
 *   2. 带锚点的链接，目标标题必须能生成该锚点（GitHub slug 规则，兼容手写 <a id>）；
 *   3. 每个文档目录里的每篇文档都必须在其入口文档里登记（见 NAV_RULES）；
 *   4. 冻结文档的内容哈希必须与登记值一致（见 FROZEN_DOCS）。
 *
 * 纯 Node、无依赖：node scripts/CheckDocs.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ROOT_DOCS = ["AGENTS.md", "CLAUDE.md", "README.md", "Client/AGENTS.md", "Server/AGENTS.md"];
const DOC_DIRS = ["Agents", "Client/docs", "Server/docs"];

/** 导航规则：目录下的每篇文档都要被入口文档链接到。 */
const NAV_RULES = [
  { owner: "AGENTS.md", dir: "Agents" },
  { owner: "AGENTS.md", files: ["Client/AGENTS.md", "Server/AGENTS.md"] },
  { owner: "Client/AGENTS.md", dir: "Client/docs" },
  { owner: "Server/AGENTS.md", dir: "Server/docs" },
];

/**
 * 冻结文档：只有用户明确准许才能修改。准许修改后，把新的哈希填进来。
 * 哈希算法为 SHA-256，换行统一成 LF 后计算，Windows 与 CI 检出结果一致。
 */
const FROZEN_DOCS = {
  "Client/docs/DesignVision.md": "b8a4267fb245a52228a5394ed19257917622962b76dd7f59feab90e1856442a3",
};

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
  for (const dir of DOC_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith(".md")) files.push(path.posix.join(dir, name));
    }
  }
  return files;
}

/** 文档里所有指向 .md 的相对链接，解析成仓库根相对路径。 */
function linkedDocs(rel) {
  const dir = path.posix.dirname(rel);
  const targets = new Set();
  for (const match of read(rel).matchAll(/\]\(([^)\s]+)\)/g)) {
    const link = match[1];
    if (/^(?:https?:|mailto:|tel:)/.test(link)) continue;
    const target = link.split("#")[0];
    if (!target.endsWith(".md")) continue;
    targets.add(path.posix.normalize(path.posix.join(dir, target)));
  }
  return targets;
}

const files = markdownFiles();
const anchorsByFile = new Map();
for (const rel of files) anchorsByFile.set(rel, collectAnchors(read(rel)));

const problems = [];

// 1、2：链接与锚点。
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

// 3：导航覆盖。
for (const rule of NAV_RULES) {
  if (!fs.existsSync(path.join(ROOT, rule.owner))) {
    problems.push(`入口文档不存在 ${rule.owner}`);
    continue;
  }
  const linked = linkedDocs(rule.owner);
  const expected = rule.files ?? files.filter((rel) => path.posix.dirname(rel) === rule.dir);
  for (const rel of expected) {
    if (!linked.has(rel)) problems.push(`${rule.owner}: 未登记 ${rel}`);
  }
}

// 4：冻结文档哈希。
for (const [rel, expected] of Object.entries(FROZEN_DOCS)) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    problems.push(`冻结文档不存在 ${rel}`);
    continue;
  }
  const normalized = read(rel).replace(/\r\n/g, "\n");
  const actual = crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
  if (actual !== expected) {
    problems.push(
      `${rel}: 冻结文档内容与登记哈希不符（实际 ${actual}）。` +
        "未经用户准许不得修改；用户准许后，把该哈希填入 scripts/CheckDocs.mjs 的 FROZEN_DOCS"
    );
  }
}

if (problems.length) {
  console.error(`发现 ${problems.length} 个文档问题：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`文档校验通过：${files.length} 个文件，链接、导航与冻结哈希均有效。`);
