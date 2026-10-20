import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * dorny/paths-filter 过滤集合的单测。
 *
 * 存在的理由（审查 F55/F56）：作业级 `if: needs.changes.outputs.<key> == 'true'` 决定一次提交
 * 跑哪些测试，而「测试守护的文件」与「触发该测试的过滤集合」分属两处，任何人都可能只改一边。
 * ci.yml 里的规则是自由文本，没人核对；本文件把两边钉在一起：
 *
 * 1. 从 ci.yml 真实解析 `filters: |` 块（不复制规则），改 workflow 会立刻反映到这里；
 * 2. 夹具矩阵断言每类改动的入选/不入选；
 * 3. 反向不变量：扫描 Server 测试里以仓库根为锚读取的**真实仓库文件路径**，逐条要求它命中
 *    所在作业所需的过滤集合——新增一份被测试读取的壳文件却忘了加过滤，就会红。
 *
 * 匹配语义用 picomatch({ dot: true }) 近似 paths-filter 的内部实现；本文件守护的是「我们自己声明的
 * 规则是否覆盖该覆盖的东西」，不声称复刻该 Action 的选项细节（升级 Action 若语义变化，
 * 由这里的夹具失败暴露）。用 `node --test` 运行，与 ClientCiFilter.mjs 同口径。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const require = createRequire(join(repoRoot, "Server/package.json"));
const picomatch = require("picomatch");

const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8").replaceAll(
  "\r\n",
  "\n"
);

/**
 * 按缩进解析 `filters: |` 块，返回 `{ 过滤名: [模式...] }`。
 * 刻意不写 `split("            server:\n")` 这类锚点抽取——历史上出过「中间插了新段，
 * 于是把后一节的规则一并算进来」的假绿（见 ClientCiFilter.mjs 顶部注释）。
 */
function parseFilters(source) {
  const start = source.search(/\n {10}filters: \|\n/);
  assert.notEqual(start, -1, "ci.yml 里找不到 `filters: |`（缩进或位置变了，解析器要跟着改）");
  const lines = source.slice(start + 1).split("\n");
  const keyIndent = " ".repeat(12);
  const ruleIndent = " ".repeat(14);
  const filters = {};
  let current = null;
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    // 首个缩进不足 12 空格的行宣告块标量结束。
    if (!/^ {12,}/.test(line)) break;
    if (line.trim().startsWith("#")) continue;
    if (line.startsWith(keyIndent) && !line.startsWith(ruleIndent)) {
      const key = line.slice(keyIndent.length).match(/^([A-Za-z][\w-]*):$/)?.[1];
      assert.ok(key, `filters 块里出现无法识别的行：${line}`);
      current = key;
      filters[key] = [];
      continue;
    }
    assert.ok(current, `过滤名之前出现规则：${line}`);
    const rule = line.slice(ruleIndent.length).match(/^- '([^']+)'$/);
    assert.ok(rule, `规则必须写成 14 空格缩进的单引号串：${line}`);
    filters[current].push(rule[1]);
  }
  return filters;
}

/** 解析 changes 作业对外导出的过滤名，用于核对「过滤名 ↔ 作业消费的名字」不漏不重。 */
function parseDeclaredOutputs(source) {
  const at = source.search(/\n {2}changes:\n/);
  assert.notEqual(at, -1, "ci.yml 里找不到 changes 作业");
  const block = source.slice(at);
  return [...block.matchAll(/([a-z][a-z0-9_-]*): \$\{\{ steps\.force\.outputs\./g)].map(
    (match) => match[1]
  );
}

const filters = parseFilters(workflow);
const matchers = new Map(
  Object.entries(filters).map(([name, patterns]) => [
    name,
    patterns.map((pattern) => picomatch(pattern, { dot: true })),
  ])
);

function hit(name, path) {
  const rules = matchers.get(name);
  assert.ok(rules, `ci.yml 的 filters 里没有名为 ${name} 的过滤集合`);
  return rules.some((rule) => rule(path));
}

const REPO_FILE = /["']((?:Client|Desktop|Mobile|Agents|tools)\/[^"']+?\.[A-Za-z0-9]+)["']/g;

test("filters 解析本身可信：六个过滤集合都非空", () => {
  assert.deepEqual(Object.keys(filters).sort(), [
    "android",
    "client",
    "desktop",
    "e2e",
    "knip",
    "server",
  ]);
  for (const [name, patterns] of Object.entries(filters))
    assert.ok(patterns.length > 0, `${name} 过滤集合为空，等于该作业永不触发`);
});

test("过滤名与 steps.filter 对外导出的名字一一对应", () => {
  assert.deepEqual(parseDeclaredOutputs(workflow).sort(), Object.keys(filters).sort());
});

/**
 * 反向不变量（F55 的正解）：测试真正读到的仓库文件必须触发跑到该测试的作业。
 * 口径：文件里以 `import.meta.dir, "../.."` 为根锚，再用字面量相对路径读取一个带扩展名的仓库文件。
 * 临时目录夹具（如 Release.test.ts 的 `join(f.root, "Client/src/data")`）没有根锚，天然不误入。
 */
for (const [filter, dir] of [
  ["server", "Server/test"],
  ["client", "Client/src"],
]) {
  const root = join(repoRoot, dir);
  const files = readdirSync(root)
    .filter((name) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(name))
    .sort();
  if (files.length === 0) continue;
  const guarded = new Set();
  for (const name of files) {
    const source = readFileSync(join(root, name), "utf8");
    if (!/import\.meta\.dir,\s*["']\.\.\/\.\.["']/.test(source)) continue;
    for (const match of source.matchAll(REPO_FILE)) guarded.add(match[1]);
  }
  test(`${dir} 按仓库根读取的文件都在 ${filter} 过滤里（当前 ${guarded.size} 项）`, () => {
    for (const path of guarded) assert.equal(hit(filter, path), true, path);
  });
}

test("被守护的具体文件清单符合预期（防解析空转）", () => {
  const source = readFileSync(
    join(repoRoot, "Server/test/ClientVersionConsistency.test.ts"),
    "utf8"
  );
  const guarded = [...source.matchAll(REPO_FILE)].map((match) => match[1]);
  assert.deepEqual([...new Set(guarded)].sort(), [
    "Desktop/src-tauri/Cargo.lock",
    "Desktop/src-tauri/Cargo.toml",
    "Desktop/src-tauri/tauri.conf.json",
    "Mobile/android/app/build.gradle",
    "Mobile/package.json",
  ]);
});

const cases = [
  // F55：只改壳版本号也要跑 Server CI。
  ["server", "Desktop/src-tauri/tauri.conf.json", true],
  ["server", "Desktop/src-tauri/Cargo.toml", true],
  ["server", "Desktop/src-tauri/Cargo.lock", true],
  ["server", "Mobile/package.json", true],
  ["server", "Mobile/android/app/build.gradle", true],
  ["server", "Mobile/android/gradle/wrapper/gradle-wrapper.properties", true],
  // 发布元数据：deploy.yml 把它喂给 buildServerReleaseMetadata，没有稳定 semver 要在这里红。
  ["server", "Client/src/data/changelog.json", true],
  ["server", "Server/test/ClientVersionConsistency.test.ts", true],
  ["server", "Server/src/Index.ts", true],
  // F56：只改依赖清单也要跑两端测试与部署门禁。
  ["server", "pnpm-lock.yaml", true],
  ["server", "pnpm-workspace.yaml", true],
  ["server", "package.json", true],
  ["server", ".github/workflows/ci.yml", true],
  ["server", ".github/workflows/deploy.yml", true],
  ["server", "Client/src/App.tsx", false],
  ["server", "Client/package.json", false],
  ["server", "Client/src/data/Awards.ts", false],
  ["server", "Agents/Testing.md", false],
  ["server", "README.md", false],
  ["server", "tools/build_bangumi_db.py", false],

  ["client", "Client/src/App.tsx", true],
  ["client", "Client/src/data/changelog.json", true],
  ["client", "Client/package.json", true],
  ["client", "Client/.storybook/main.ts", true],
  ["client", "Client/e2e/App.spec.ts", false],
  ["client", "Server/src/shared/models/A.ts", true],
  ["client", "Server/scripts/ClientCiFilter.mjs", true],
  ["client", "pnpm-lock.yaml", true],
  ["client", "pnpm-workspace.yaml", true],
  ["client", "package.json", true],
  ["client", "Server/src/Index.ts", false],
  ["client", "Desktop/src-tauri/tauri.conf.json", false],
  ["client", "Mobile/package.json", false],
  ["client", ".github/workflows/deploy.yml", false],

  // 桌面壳加载远程 URL，不内嵌前端产物：改 Client 不该重打安装包。
  ["desktop", "Desktop/src-tauri/tauri.conf.json", true],
  ["desktop", "Desktop/src-tauri/Cargo.lock", true],
  ["desktop", ".github/workflows/ci.yml", true],
  ["desktop", "Client/src/App.tsx", false],
  ["desktop", "Mobile/package.json", false],
  ["desktop", "Server/src/Index.ts", false],
  ["desktop", "pnpm-lock.yaml", false],

  ["android", "Mobile/android/app/build.gradle", true],
  ["android", "Mobile/package.json", true],
  ["android", "Mobile/package-lock.json", true],
  ["android", "Mobile/android/app/src/main/AndroidManifest.xml", true],
  // 安卓壳内嵌 Client 产物，前端一改 APK 内容就变。
  ["android", "Client/src/App.tsx", true],
  ["android", "pnpm-lock.yaml", true],
  ["android", "pnpm-workspace.yaml", true],
  ["android", "package.json", true],
  ["android", "Server/src/Index.ts", false],
  ["android", "Desktop/src-tauri/tauri.conf.json", false],

  ["knip", "knip.jsonc", true],
  ["knip", "Client/src/App.tsx", true],
  ["knip", "Server/src/Index.ts", true],
  ["knip", "Server/scripts/ServerCiFilter.mjs", true],
  ["knip", "pnpm-lock.yaml", true],
  ["knip", "Mobile/package.json", false],

  ["e2e", "Client/src/App.tsx", true],
  ["e2e", "Server/src/Index.ts", true],
  ["e2e", "pnpm-lock.yaml", true],
  ["e2e", "pnpm-workspace.yaml", true],
  ["e2e", "package.json", true],
  ["e2e", "knip.jsonc", false],
  ["e2e", "Agents/Spec.md", false],
];

for (const [filter, path, expected] of cases)
  test(`${filter} OR filter ${path} => ${expected}`, () =>
    assert.equal(hit(filter, path), expected));
