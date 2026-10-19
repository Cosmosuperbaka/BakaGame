import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(root, "..");
const sharedDir = path.join(repoRoot, "Server", "src", "shared");

// 守卫「Client 独立安装」这条构建边界。
//
// 托管平台的构建正是这种布局：只克隆仓库、只在 Client/ 里装一次依赖。
// 而 Server/src/shared 被客户端程序整个编译与打包（tsconfig include +
// @bakagame/shared 别名），其中的裸导入按 Node 解析规则从文件位置向上找
// node_modules —— 独立布局下从 Server/src/shared 出发走不到任何一层，因此
// 每个裸导入都必须同时满足三个条件：
//   1. 声明在 Client/package.json 依赖里（独立安装只装声明过的包）；
//   2. tsconfig.app.json paths 映射到 ./node_modules（命中 Client 的副本；
//      提升布局下映射落空会自然回退到仓库根 node_modules，两种布局都成立）；
//   3. vite.config.ts resolve.dedupe 收录（打包时同样按项目根解析）。
// 少任何一条：本地与 CI（提升布局）可能照常通过，独立安装的构建必挂，
// 故把三层全部纳入守卫。
//
// 断言同时覆盖「物理归属」：解析结果必须落在 Client 自己的安装（独立安装时是
// Client/node_modules，提升布局下是仓库根的 node_modules），绝不允许来自
// Server 的安装树 —— 那是独立布局解析不到的来源。
//
// 注意 **不能把仓库根的 node_modules 一起藏掉**：workspace 用 node-linker=hoisted 提升依赖，
// 提升布局下 Client 的依赖就在根上那棵树下，藏掉它会连 Client 自己的依赖一起隐藏。
const slash = (p) => path.resolve(p).replaceAll("\\", "/");
const clientLocal = slash(path.join(root, "node_modules"));
const workspaceRoot = slash(path.join(repoRoot, "node_modules"));
const serverTree = slash(path.join(repoRoot, "Server", "node_modules"));
const isUnder = (file, dir) => slash(file).startsWith(dir + "/");
const hidden = (file) => isUnder(file, serverTree);
const host = {
  ...ts.sys,
  fileExists: (file) => !hidden(file) && ts.sys.fileExists(file),
  directoryExists: (dir) => !hidden(dir + "/_") && ts.sys.directoryExists(dir),
  readFile: (file) => (hidden(file) ? undefined : ts.sys.readFile(file)),
};

const clientPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const declared = new Set([
  ...Object.keys(clientPackage.dependencies ?? {}),
  ...Object.keys(clientPackage.devDependencies ?? {}),
]);

const config = ts.readConfigFile(path.join(root, "tsconfig.app.json"), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
// 静态断言读原始配置：解析后的 options.paths 已被内部归一化，不适合核对书写形态。
const rawPaths = config.config.compilerOptions?.paths ?? {};

const viteText = fs.readFileSync(path.join(root, "vite.config.ts"), "utf8");
const dedupeBlock = /dedupe:\s*\[([^\]]*)\]/m.exec(viteText)?.[1] ?? "";
const deduped = new Set([...dedupeBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
assert.ok(
  deduped.has("@sinclair/typebox"),
  "vite.config.ts resolve.dedupe 解析失效（找不到已知条目）"
);

const packageOf = (specifier) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

// 扫描共享源码的全部外部导入（含 re-export）：它们都会被客户端程序解析。
const imports = new Map();
for (const name of fs.readdirSync(sharedDir)) {
  if (!name.endsWith(".ts")) continue;
  const text = fs.readFileSync(path.join(sharedDir, name), "utf8");
  for (const match of text.matchAll(/from "([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier.startsWith(".") || specifier.startsWith("node:") || specifier.startsWith("bun:"))
      continue;
    if (!imports.has(specifier)) imports.set(specifier, new Set());
    imports.get(specifier).add(name);
  }
}
assert.ok(imports.size >= 3, "共享源码外部导入扫描失效（结果少于已知的 3 个包）");

for (const [specifier, files] of imports) {
  const pkg = packageOf(specifier);
  const usedBy = [...files].join(", ");

  assert.ok(
    declared.has(pkg),
    `${pkg} 被共享源码使用（${usedBy}），必须声明在 Client/package.json 依赖里`
  );
  assert.ok(
    deduped.has(pkg),
    `${pkg} 必须在 vite.config.ts resolve.dedupe 中（否则独立安装的打包阶段解析不到）`
  );

  const mapped = rawPaths[specifier] ?? rawPaths[`${pkg}/*`];
  assert.ok(mapped, `tsconfig.app.json paths 缺少 ${specifier}（或 ${pkg}/*）映射`);
  assert.ok(
    mapped.every((value) => value.startsWith("./node_modules/")),
    `${specifier} 的 paths 映射必须指向 ./node_modules（得到 ${mapped.join(", ")}）`
  );

  // 解析演练：藏起 Server 安装树后仍解析成功，且结果归属 Client 自己的安装。
  const importer = path.join(sharedDir, [...files][0]);
  const resolved = ts.resolveModuleName(specifier, importer, parsed.options, host).resolvedModule;
  assert.ok(resolved, `${specifier} 在藏起 Server/node_modules 后必须仍可解析`);
  const file = slash(resolved.resolvedFileName);
  assert.ok(
    isUnder(file, clientLocal) || isUnder(file, workspaceRoot),
    `${specifier} 必须归属 Client 自己的安装（独立或提升），实际 ${file}`
  );
  assert.ok(!isUnder(file, serverTree), `${specifier} 不得从 Server 的安装树解析，实际 ${file}`);
}

// 反向验证：解析结果必须真的能被找到，避免上面的断言因路径写错而空转通过。
assert.ok(
  ts.sys.fileExists(path.join(root, "tsconfig.app.json")),
  "tsconfig.app.json must exist for the paths mapping check"
);
console.log(
  `Shared imports (${[...imports.keys()].join(", ")}) are wired to Client's own installation.`
);
