#!/usr/bin/env node
/**
 * 导出「可供容器内 `npm ci` 使用的运行时锁」。
 *
 * 为什么需要（审查 F51）：CI 用 pnpm workspace 安装（唯一权威锁是根 pnpm-lock.yaml），
 * 而生产容器里是 npm 单包安装运行时依赖（见 Server/.npmrc 与 Agents/Deployment.md §8）。
 * 两条解析路径并存的结果是「获验的依赖树」与「线上装的依赖树」可以不是同一棵，
 * 而 `legacy-peer-deps` 还会把 ERESOLVE 冲突咽下去。仓库里没有 Dockerfile，
 * 无法静态证明生产镜像另有锁定层，所以先把漂移面收窄到可核对的程度：
 *
 *   直接依赖钉到 CI 已解析出的那一枚精确版本 → 交给 npm 自己的解析器产出一份合法的
 *   lockfileVersion 3 锁 → 作为 CI 构件上传，镜像构建与容器安装只消费它（`npm ci`）。
 *
 * 本脚本**不**假装能替 pnpm-lock 做传递依赖的翻译：产物里传递依赖由 npm 解析，
 * 与 pnpm 的 `.pnpm/` 布局不可能逐字节相同。它保证的是「直接依赖不再浮动」+「有一枚可复现的锁」。
 * 不自写转换器是有意的：pnpm 的锁没有 integrity 字段可用，硬拼出来的 npm 锁会在 `npm ci` 时
 * 因缺 resolved/integrity 而失败，或更糟——静默装成别的东西。
 *
 * 用法：node Server/scripts/ExportNpmLock.mjs [--out <path>] [--quiet]
 * 退出码：0 成功；1 输入不合口径（未知 specifier 形态、解析不到已安装版本、产物校验不过）。
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "..");
const repoRoot = resolve(serverRoot, "..");

/** 口径外的情形一律抛错：宁可让 CI 失败，也不要悄悄产出一份「看着对」的锁。 */
class ExportError extends Error {}

const fail = (message) => {
  throw new ExportError(message);
};

/** 取 CI（或本机）已解析出的那枚版本；先查本包 node_modules，再查 hoisted 的根 node_modules。 */
const installedVersion = (name) => {
  for (const base of [join(serverRoot, "node_modules"), join(repoRoot, "node_modules")]) {
    const file = join(base, ...name.split("/"), "package.json");
    try {
      const version = JSON.parse(readFileSync(file, "utf8")).version;
      if (typeof version === "string") return version;
    } catch {
      // 该候选位置没有这个包，继续下一个。
    }
  }
  return undefined;
};

/**
 * 支持的 range 形态就是 Server/package.json 现在用到的那几种。
 * 认不出的形态一律失败：宁可让 CI 报错，也不要悄悄产出一份「看着对」的锁。
 */
const pin = (name, specifier) => {
  if (specifier.startsWith("workspace:") || specifier.startsWith("catalog:"))
    fail(`${name} 用的是 workspace/catalog 协议，npm 侧无法这样安装，需要人工决定它的运行时形态`);
  if (/^(git|file|github|npm:[^@]+@[^0-9])/.test(specifier) || /:\/\/|github:/.test(specifier))
    fail(`${name} 的 specifier "${specifier}" 不是注册表版本区间，本脚本不猜它的锁内容`);
  const aliased = specifier.match(/^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/);
  if (aliased) {
    const target = pin(aliased[1], aliased[2]);
    return `npm:${aliased[1]}@${target}`;
  }
  const exact = specifier.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (exact) return specifier;
  const caret = specifier.match(/^\^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  const tilde = specifier.match(/^~(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!caret && !tilde) fail(`${name} 的 specifier "${specifier}" 形态未支持，请改脚本或改清单`);
  const resolved = installedVersion(name);
  if (!resolved)
    fail(
      `${name} 在 node_modules 里找不到已安装版本（先跑 pnpm install --frozen-lockfile 再导出）`
    );
  const [major, minor] = resolved.split(".").map(Number);
  const [, wantMajor, wantMinor] = (caret ?? tilde).map(Number);
  if (major !== wantMajor || (tilde && minor !== wantMinor))
    fail(
      `${name} 已解析到 ${resolved}，与声明区间 "${specifier}" 不符：` +
        "要么 node_modules 与清单不同步，要么这条区间的语义超出了本脚本的支持面"
    );
  return resolved;
};

const manifestOf = (serverManifest, rootManifest) => {
  const dependencies = {};
  for (const [name, specifier] of Object.entries(serverManifest.dependencies ?? {}))
    dependencies[name] = pin(name, specifier);
  return {
    name: "bakagame-server-runtime",
    version: serverManifest.version ?? "0.0.0",
    private: true,
    description:
      "Server 运行时依赖的 npm 口径清单：由 Server/scripts/ExportNpmLock.mjs 从 CI 已解析版本生成，只为产出 npm 锁，不用于安装应用代码。",
    engines: rootManifest.engines,
    dependencies,
  };
};

/**
 * npm 的调用方式。
 * Windows 上 `npm` 是 `npm.cmd` 垫片，不经 shell 就 spawn 不到它；
 * 经 npm/pnpm 的脚本入口调用时 `npm_execpath` 直接指向 npm-cli.js，那就用当前 node 起它，
 * 既绕开垫片又保证「用的就是这个 node 旁边的那套 npm」。
 * 退回 shell 时只拼常量旗标、不拼任何路径（工作目录走 cwd），所以没有注入面，
 * 也不会踩 Node 的「args + shell」弃用警告。
 */
const NPM_ARGS = ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];

const npmRun = (work, quiet) => {
  const options = {
    cwd: work,
    stdio: quiet ? "ignore" : "inherit",
    // 经 pnpm 调用时它注入的 npm_config_* 会改变 npm 的行为（含 UA 触发的注册表差异）。
    env: { ...process.env, npm_config_user_agent: "npm" },
  };
  const cli = process.env.npm_execpath;
  if (cli && existsSync(cli)) return execFileSync(process.execPath, [cli, ...NPM_ARGS], options);
  if (process.platform === "win32")
    return execFileSync(`npm ${NPM_ARGS.join(" ")}`, [], { ...options, shell: true });
  return execFileSync("npm", NPM_ARGS, options);
};

const main = () => {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf("--out");
  const out = resolve(
    outIndex === -1 ? join(serverRoot, "build", "server-npm-lock.json") : argv[outIndex + 1]
  );
  const quiet = argv.includes("--quiet");

  const serverManifest = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8"));
  const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const manifest = manifestOf(serverManifest, rootManifest);
  const declared = Object.keys(serverManifest.dependencies ?? {});
  if (declared.length === 0) fail("Server/package.json 里没有 dependencies，产物没有意义");

  const work = join(tmpdir(), `bakagame-npm-lock-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    writeFileSync(join(work, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    // 安装行为必须与生产一致：Server/.npmrc 里那条 legacy-peer-deps 就是为了让容器装得动。
    copyFileSync(join(serverRoot, ".npmrc"), join(work, ".npmrc"));
    npmRun(work, quiet);
    const lock = JSON.parse(readFileSync(join(work, "package-lock.json"), "utf8"));
    if (lock.lockfileVersion !== 3)
      fail(`产物 lockfileVersion=${lock.lockfileVersion}，npm ci 需要 3`);
    const roots = lock.packages?.[""]?.dependencies ?? {};
    const mismatched = declared.filter((name) => roots[name] !== manifest.dependencies[name]);
    if (mismatched.length > 0)
      fail(
        `npm 没有按钉住的版本解析：${mismatched.map((name) => `${name}=${roots[name]}`).join(", ")}`
      );
    for (const [name, entry] of Object.entries(lock.packages ?? {})) {
      if (name === "" || typeof entry !== "object") continue;
      if (!entry.resolved) fail(`产物里 ${name} 缺 resolved，npm ci 会拒绝这样的锁`);
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    console.log(
      `ExportNpmLock: 直接依赖 ${declared.length} 枚已钉死，锁含 ${Object.keys(lock.packages ?? {}).length - 1} 个包 → ${out}`
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { manifestOf, pin };
