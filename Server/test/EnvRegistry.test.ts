import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { ENV_ENTRIES, renderEnvExample, type EnvEntry } from "../src/config/env/Registry";
import { ENV_EXAMPLE_PATH } from "../src/scripts/ExportEnvExample";

const SERVER_ROOT = resolve(import.meta.dir, "..");

/** 真正会读环境变量的代码面：应用源码、脚本与集成用例。单测里临时设的开关不算。 */
const SCAN_ROOTS = ["src", "scripts", "integration"];

const ENV_READ_PATTERN = /\b(?:Bun|process)\.env\.([A-Z][A-Z0-9_]*)/g;

const tsFiles = (directory: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(directory, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(full);
  }
  return out;
};

/** 扫出代码里出现过的环境变量名，附带首个出现位置便于定位。 */
const readEnvNames = (): Map<string, string> => {
  const found = new Map<string, string>();
  for (const root of SCAN_ROOTS) {
    for (const file of tsFiles(resolve(SERVER_ROOT, root))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(ENV_READ_PATTERN)) {
        const name = match[1];
        if (!found.has(name)) found.set(name, file.slice(SERVER_ROOT.length + 1));
      }
    }
  }
  return found;
};

const entries = (): Map<string, EnvEntry> =>
  new Map(ENV_ENTRIES.map((entry) => [entry.name, entry]));

/** 允许出现在被追踪文件里的虚构主机名（根 AGENTS.md「真实凭据、私有域名与生产配置一律不进」）。 */
const PLACEHOLDER_HOSTS = [
  "example.com",
  "example.test",
  "example.invalid",
  "localhost",
  "ingest.sentry.io",
];

const hostOf = (value: string): string | undefined => {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
};

describe("环境变量注册表", () => {
  it("注册表无重名", () => {
    expect(ENV_ENTRIES.length).toBe(entries().size);
  });

  it("代码读到的每个变量都必须在注册表里分层", () => {
    const registered = entries();
    const unregistered = [...readEnvNames()].filter(([name]) => !registered.has(name));
    // 新增变量必须先在 config/env/Registry.ts 表态它属于哪一层（引导 / 拓扑 / 部署期 / 运行期 / 脚本）。
    expect(unregistered).toEqual([]);
  });

  it("T0~T3 的每一项都仍有代码读取，不留悬空条目", () => {
    const read = readEnvNames();
    const dangling = ENV_ENTRIES.filter(
      (entry) => ["T0", "T1", "T2", "T3"].includes(entry.layer) && !read.has(entry.name)
    ).map((entry) => entry.name);
    expect(dangling).toEqual([]);
  });

  it("凭据类变量的示例值只能是留空或虚构占位", () => {
    const offenders = ENV_ENTRIES.filter((entry) => {
      if (!entry.secret || !entry.sample) return false;
      const host = hostOf(entry.sample);
      // 样例必须能解析出一个地址，且主机名落在虚构清单内；解析不出的凭据样例一律不收。
      return (
        !host ||
        !PLACEHOLDER_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
      );
    }).map((entry) => `${entry.name}=${entry.sample}`);
    expect(offenders).toEqual([]);
  });

  it("提交在库的 .env.example 与注册表生成的内容逐字一致", () => {
    const committed = readFileSync(ENV_EXAMPLE_PATH, "utf8").replace(/\r\n/g, "\n");
    expect(committed).toBe(renderEnvExample());
  });
});
