import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * typescript 的 CLI 入口名随版本变化：5.x 是 `bin/tsc`，6.x 起是 `bin/tsc6`。
 * 因此不能用 `require.resolve("typescript/bin/tsc")` 定位——升级后解析不到会让整条 E2E 红掉。
 */
const resolveTscCli = () => {
  const candidates = [];
  for (const root of [path.join(clientDir, "node_modules"), path.join(clientDir, "..", "node_modules")]) {
    for (const name of ["tsc", "tsc6"]) candidates.push({ file: path.join(root, "typescript", "bin", name), viaNode: true });
    candidates.push({ file: path.join(root, ".bin", process.platform === "win32" ? "tsc.CMD" : "tsc"), viaNode: false });
  }
  return candidates.find((candidate) => existsSync(candidate.file));
};

// Explicit process values defeat inherited production values. envDir:false also blocks .env files.
process.env.NODE_ENV = "production";
process.env.VITE_SENTRY_DSN = "";
process.env.VITE_SERVER_URL = "http://127.0.0.1:4850";
const tscCli = resolveTscCli();
if (!tscCli) throw new Error("未找到 typescript 的 tsc 入口：先在仓库根安装依赖");
const result = spawnSync(tscCli.viaNode ? process.execPath : tscCli.file, tscCli.viaNode ? [tscCli.file, "-b"] : ["-b"], {
  cwd: clientDir, env: process.env, stdio: "inherit", shell: !tscCli.viaNode && process.platform === "win32",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const { build } = await import("vite");
await build({ root: clientDir, mode: "production", envDir: false });
