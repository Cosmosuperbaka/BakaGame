/**
 * 容器侧运行时依赖版本核对（审查 F51 的下限保证）。
 *
 * 部署作业把 CI 获验的 npm 锁落到挂载树，容器入口的 npm 安装据此只装那一套版本；
 * 但「装完」与「装对」是两件事：制品缺失、锁过大而不下发、或入口用了别的安装口径时，
 * 线上完全可能装着与获验树不同的版本。这里用锁里导出的**直接依赖精确版本清单**
 * （`Server/scripts/StageNpmLock.mjs` 的 pins）在容器内逐包核对，把静默漂移变成部署失败。
 *
 * 必须自包含（只允许 node: 内置模块）：经 stdin 喂给容器里的 bun 执行。
 * 输入：NPM_PINS=name@version,name@version,…（来自获验锁，不含区间）
 *      NPM_MODULES 可覆盖 node_modules 根，默认 /app/node_modules。
 * 退出码：0 全部一致；1 存在不符或未安装。
 */
import { readFileSync } from "node:fs";

const pins = (process.env.NPM_PINS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

if (pins.length === 0) {
  console.error("❌ NPM_PINS 为空：没有可核对的获验版本清单（不应在无制品时调用本脚本）");
  process.exit(1);
}

const modulesRoot = process.env.NPM_MODULES?.trim() || "/app/node_modules";
const mismatched: string[] = [];

for (const pin of pins) {
  const at = pin.lastIndexOf("@");
  if (at <= 0) {
    mismatched.push(`${pin}（清单形态异常）`);
    continue;
  }
  const name = pin.slice(0, at);
  const wanted = pin.slice(at + 1);
  let installed: unknown;
  try {
    installed = JSON.parse(readFileSync(`${modulesRoot}/${name}/package.json`, "utf8")).version;
  } catch {
    mismatched.push(`${name}: 容器内读不到 ${modulesRoot}/${name}/package.json`);
    continue;
  }
  if (typeof installed !== "string" || installed !== wanted)
    mismatched.push(`${name}: 线上 ${String(installed)} ≠ 获验 ${wanted}`);
}

if (mismatched.length > 0) {
  console.error(`❌ 运行时依赖与 CI 获验的 npm 锁不符（${mismatched.length} 项）：`);
  for (const line of mismatched) console.error(`   - ${line}`);
  process.exit(1);
}

console.log(`运行时依赖版本核对通过：${pins.length} 个直接依赖与获验锁一致`);
