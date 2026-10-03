import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = ts.readConfigFile(path.join(root, "tsconfig.app.json"), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const serverModules = path.resolve(root, "../Server/node_modules").replaceAll("\\", "/");
const hidden = (file) => path.resolve(file).replaceAll("\\", "/").startsWith(serverModules + "/");
const host = { ...ts.sys, fileExists: (file) => !hidden(file) && ts.sys.fileExists(file), directoryExists: (dir) => !hidden(dir + "/_") && ts.sys.directoryExists(dir), readFile: (file) => hidden(file) ? undefined : ts.sys.readFile(file) };
for (const name of ["@sinclair/typebox", "@sinclair/typebox/value"]) {
  const resolved = ts.resolveModuleName(name, path.resolve(root, "../Server/src/shared/CCB.ts"), parsed.options, host).resolvedModule;
  assert.ok(resolved, `${name} must resolve with Server/node_modules hidden`);
  assert.ok(path.resolve(resolved.resolvedFileName).replaceAll("\\", "/").startsWith(root.replaceAll("\\", "/") + "/node_modules/"), `${name} must belong to Client`);
}
console.log("Shared TypeBox imports resolve from the independent Client installation.");
