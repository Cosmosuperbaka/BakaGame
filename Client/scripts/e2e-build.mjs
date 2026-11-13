import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 与 `npm run build` 的 `tsc -b` 同一个编译器：类型检查走原生编译器（typescript7 别名），
// 而不是 node_modules/typescript（那条线是给 lint 用的程序化 API，版本不同，结论可能不同）。
// 包的 exports 不开放 bin 子路径，所以经 package.json 取 bin 声明再拼路径。
const typescriptPackage = require.resolve("typescript7/package.json");
const tscCli = path.join(
  path.dirname(typescriptPackage),
  require(typescriptPackage).bin.tsc
);

// Explicit process values defeat inherited production values. envDir:false also blocks .env files.
process.env.NODE_ENV = "production";
process.env.VITE_SENTRY_DSN = "";
process.env.VITE_SERVER_URL = "http://127.0.0.1:4850";
const result = spawnSync(process.execPath, [tscCli, "-b"], {
  cwd: clientDir,
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const { build } = await import("vite");
await build({ root: clientDir, mode: "production", envDir: false });
