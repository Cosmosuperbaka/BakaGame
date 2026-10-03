import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Explicit process values defeat inherited production values. envDir:false also blocks .env files.
process.env.NODE_ENV = "production";
process.env.VITE_SENTRY_DSN = "";
process.env.VITE_SERVER_URL = "http://127.0.0.1:4850";
const result = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-b"], {
  cwd: clientDir, env: process.env, stdio: "inherit", shell: false,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const { build } = await import("vite");
await build({ root: clientDir, mode: "production", envDir: false });
