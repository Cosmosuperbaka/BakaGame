import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = ts.readConfigFile(path.join(root, "tsconfig.app.json"), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const slash = (p) => path.resolve(p).replaceAll("\\", "/");

// 断言两个必须同时成立的边界（workspace 迁移后仍然成立）：
//   1. Client 侧解析到的 TypeBox **物理上属于 Client 自己的安装**（独立安装时是
//      Client/node_modules，提升布局下是仓库根的 node_modules），而不是 Server 的树；
//   2. Client 能独立解析 —— 把 Server 的安装树整个藏起来后依然解析成功。
//
// 注意 **不能把仓库根的 node_modules 一起藏掉**：workspace 用 node-linker=hoisted 提升依赖，
// Client 的 tsconfig paths 与 Vite alias 都指向根上那一份，藏掉它会连 Client 自己的依赖一起隐藏。
const clientLocal = slash(path.join(root, "node_modules"));
const repoRoot = slash(path.resolve(root, ".."));
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

for (const name of ["@sinclair/typebox", "@sinclair/typebox/value"]) {
  const resolved = ts.resolveModuleName(name, path.resolve(root, "../Server/src/shared/CCB.ts"), parsed.options, host).resolvedModule;
  assert.ok(resolved, `${name} must still resolve with Server/node_modules hidden`);
  const file = slash(resolved.resolvedFileName);
  assert.ok(
    isUnder(file, clientLocal) || isUnder(file, workspaceRoot),
    `${name} must belong to Client's own installation (independent or hoisted), got ${file}`,
  );
  assert.ok(!isUnder(file, serverTree), `${name} must not come from Server's installation, got ${file}`);
}

// 反向验证：解析结果必须真的能被找到，避免上面的断言因路径写错而空转通过。
assert.ok(ts.sys.fileExists(path.join(root, "tsconfig.app.json")), "tsconfig.app.json must exist for the paths mapping check");
console.log("Shared TypeBox imports resolve from Client-declared dependencies, never from Server's tree.");
