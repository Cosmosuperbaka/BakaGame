import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { createRequire } from "node:module";
import sharp from "sharp";
import { preparePublicWebp, stickerAssetUrl } from "./scripts/prepare-public-webp.mjs";
import {
  PAGE_META,
  REPOSITORY_URL,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_TAGLINE,
  buildFaqStructuredData,
  type PageMeta,
} from "./src/data/PageMeta.ts";
import {
  CREDIT_DESCRIPTION_LIMIT,
  LICENSE_FILE_PATTERN,
  UNKNOWN_LICENSE,
  licenseBucket,
} from "./src/lib/Credits.ts";
import type {
  CreditDependency,
  CreditLicenseBucket,
  CreditLicenseFile,
  CreditsManifest,
  CreditScope,
} from "./src/lib/Credits.ts";
import {
  COMMIT_HISTORY_LIMIT,
  commitsApiUrl,
  mapGitHubCommits,
  normalizeCommitEntries,
} from "./src/lib/CommitHistory.ts";
import type { CommitEntry, CommitHistory } from "./src/lib/CommitHistory.ts";

// ==================== Vite 插件：构建时注入提交历史 ====================
// 以虚拟模块提供数据，随 JS 产物一同带 hash：
// 落到 public/ 的固定文件名会被 CDN 按不变资源长期缓存，内容更新后前端取不到。
//
// 取数优先走 GitHub 接口而不是 git log：构建容器是浅克隆（depth=1），
// `git log -n 30` 在平台侧只能拿到 HEAD 一条，页脚弹窗里就只剩一行记录。
// 接口取不到时逐级降级回本地 git 日志、再到空数组——任何一步失败都不该让构建挂掉。

const COMMIT_HISTORY_ID = "virtual:commit-history";

/** 构建期等接口的硬上限：构建机出网慢时不能把整次构建拖住。 */
const COMMIT_HISTORY_API_TIMEOUT_MS = 3000;

export function commitHistoryPlugin(options: {
  useRemote: boolean;
  /**
   * 读本地 git 的命令入口，默认走 execSync。
   * 抽成参数是为了让降级链（接口失败 → git 日志 → 空数组）能被确定性地测到：
   * 直接调 git 的用例在跑不了子进程的环境里只能整条跳过。
   */
  execGit?: (args: string) => string;
}) {
  const resolvedId = "\0" + COMMIT_HISTORY_ID;

  // load 与 transformIndexHtml 都要用，同一次构建里跑一次就够。
  let collected: Promise<CommitHistory> | undefined;

  function runGit(args: string) {
    if (options.execGit) return options.execGit(args);
    return execSync(`git ${args}`, { encoding: "utf-8" }).trim();
  }

  function revision() {
    try {
      return runGit("rev-parse HEAD");
    } catch {
      return "";
    }
  }

  function shortRevision() {
    try {
      // 空串等同取不到：版本提示与 Sentry release 都靠它判断，不能留空值。
      return runGit("rev-parse --short HEAD") || "dev";
    } catch {
      // 非 git 工作区（平台直接给源码包）时退化为占位值，前端据此跳过版本提示。
      return "dev";
    }
  }

  /**
   * 本地 git 日志。浅克隆下只有一条，但作为接口失败后的兜底仍然成立：
   * 一条也比空列表强，何况本地开发跑的是完整历史。
   */
  function collectFromGit(): CommitEntry[] {
    try {
      // 日期取 iso-strict 带时区：--date=short 只到天，相对时间会全部退化成「今天」。
      const raw = runGit("log -n 30 --date=iso-strict --format=%H%x00%s%x00%ad%x00%an%x1F");

      // 用 \x00 分隔字段、\x1F 分隔记录，避开提交信息里的空格与换行。
      const records = raw
        .split("\x1F")
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
          const parts = record.split("\x00");
          return {
            hash: parts[0] ?? "",
            message: parts[1] ?? "",
            date: parts[2] ?? "",
            author: parts[3] ?? "",
          };
        });

      return normalizeCommitEntries(records);
    } catch {
      return [];
    }
  }

  /** 构建期走 GitHub 接口：数据与远端仓库同源，且不受构建容器的克隆深度影响。 */
  async function collectFromGitHub(revisionSha: string): Promise<CommitEntry[]> {
    const endpoint = commitsApiUrl(REPOSITORY_URL, revisionSha, COMMIT_HISTORY_LIMIT);
    if (!endpoint) return [];

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bakagame-build",
    };
    // 未认证限流按出口 IP 每小时 60 次；构建频率远低于此，Token 只是保险。
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const response = await fetch(endpoint, {
        headers,
        signal: AbortSignal.timeout(COMMIT_HISTORY_API_TIMEOUT_MS),
      });
      if (!response.ok) return [];

      return mapGitHubCommits(await response.json(), COMMIT_HISTORY_LIMIT);
    } catch {
      // 限流、超时、断网、构建提交尚未推送（422）都落这里，交给调用方降级。
      return [];
    }
  }

  async function collect(): Promise<CommitHistory> {
    let commits = options.useRemote ? await collectFromGitHub(revision()) : [];
    if (commits.length === 0) commits = collectFromGit();

    // 不输出版本号：展示版本号一律以 changelog.json 为准，
    // 免得 package.json 与更新日志各说一套。
    return { generatedAt: new Date().toISOString(), currentCommit: shortRevision(), commits };
  }

  return {
    name: "commit-history",
    resolveId(id: string) {
      return id === COMMIT_HISTORY_ID ? resolvedId : null;
    },
    async load(id: string) {
      if (id !== resolvedId) return null;

      collected ??= collect();
      return `export default ${JSON.stringify(await collected)}`;
    },
    transformIndexHtml() {
      // 版本提示靠这个 meta 判断线上是否有新版本，必须与提交列表第一条同源，
      // 所以这里取本地 HEAD，而不是接口返回的最新提交。
      return [
        {
          tag: "meta",
          attrs: {
            name: "bakagame-build",
            content: shortRevision(),
          },
          injectTo: "head" as const,
        },
      ];
    },
  };
}

// ==================== Vite 插件：扫描表情包目录生成清单 ====================
// 以虚拟模块提供数据，随 JS 产物一同带 hash：
// 落到 public/ 的固定文件名会被 CDN 按不变资源长期缓存，新增表情包后老用户取不到。

const STICKER_EXTENSIONS = [".gif", ".png", ".apng", ".webp", ".jpg", ".jpeg"];

/**
 * 判断单个文件是否为动图。扩展名只是第一道线索：
 * info.txt 里的下载地址一律写成 .png，动图包也不例外，所以只能看磁盘上的真实文件。
 * APNG 与动态 WebP 都可能顶着静态图的扩展名，因此再嗅一次容器里的动画标记块。
 */
function detectAnimated(filePath: string, ext: string) {
  if (ext === ".gif" || ext === ".apng") return true;
  if (ext !== ".png" && ext !== ".webp") return false;

  try {
    // 动画标记块都在文件头部：APNG 的 acTL 必须在第一帧之前，WebP 的 ANIM 紧跟 VP8X。
    const head = Buffer.alloc(4096);
    const fd = fs.openSync(filePath, "r");
    const read = fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);

    const chunk = head.subarray(0, read);
    return ext === ".png" ? chunk.includes("acTL") : chunk.includes("ANIM");
  } catch {
    return false;
  }
}

/**
 * 从 info.txt 解析包的显示名与表情排序。
 * `# 名称：xxx` 给出包名，`# [包名_表情名]` 的出现顺序即权威排序。
 */
function parseInfoFile(packDir: string) {
  const order: string[] = [];
  let displayName = "";

  try {
    const raw = fs.readFileSync(path.join(packDir, "info.txt"), "utf-8");

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("#")) continue;

      const nameMatch = trimmed.match(/^#\s*名称[：:]\s*(.+)$/);
      if (nameMatch) {
        displayName = nameMatch[1].trim();
        continue;
      }

      // 形如 `# [夜愿华章表情包_鼓掌]`，取下划线后的表情名。
      const itemMatch = trimmed.match(/^#\s*\[(.+)\]$/);
      if (itemMatch) {
        const key = itemMatch[1].slice(itemMatch[1].indexOf("_") + 1).trim();
        if (key && !order.includes(key)) order.push(key);
      }
    }
  } catch {
    /* 没有 info.txt 时退化为按文件名排序 */
  }

  return { displayName, order };
}

const STICKER_MANIFEST_ID = "virtual:sticker-manifest";

function stickerManifestPlugin(emojiDir: string) {
  const resolvedId = "\0" + STICKER_MANIFEST_ID;

  function collect() {
    let packs: unknown[] = [];

    try {
      packs = fs
        .readdirSync(emojiDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const packDir = path.join(emojiDir, entry.name);
          const { displayName, order } = parseInfoFile(packDir);

          const items = fs
            .readdirSync(packDir, { withFileTypes: true })
            .filter((file) => file.isFile())
            .filter((file) => STICKER_EXTENSIONS.includes(path.extname(file.name).toLowerCase()))
            .map((file) => {
              const ext = path.extname(file.name).toLowerCase();
              const base = path.basename(file.name, path.extname(file.name));
              // 文件名形如 `[包名_表情名]`，去掉方括号后取下划线之后的部分作表情名。
              const inner = base.replace(/^\[/, "").replace(/\]$/, "");
              const underscore = inner.indexOf("_");
              const key = (underscore >= 0 ? inner.slice(underscore + 1) : inner).trim();
              const filePath = path.join(packDir, file.name);

              return {
                key,
                label: key,
                path: stickerAssetUrl(path.relative(emojiDir, filePath), fs.readFileSync(filePath)),
                animated: detectAnimated(filePath, ext),
              };
            })
            // info.txt 里列出的按其顺序排在前，未列出的按名称追加在后。
            .sort((left, right) => {
              const leftIndex = order.indexOf(left.key);
              const rightIndex = order.indexOf(right.key);
              if (leftIndex !== rightIndex) {
                if (leftIndex < 0) return 1;
                if (rightIndex < 0) return -1;
                return leftIndex - rightIndex;
              }
              return left.key.localeCompare(right.key, "zh-Hans-CN");
            });

          return {
            name: displayName || entry.name,
            dir: entry.name,
            // 代表图取排序后的首个表情，保证每个包的标签图稳定且互不相同。
            preview: items[0]?.path ?? "",
            // 整包都是动图时才在标签上打角标；混装包只在具体表情上标。
            animated: items.length > 0 && items.every((item) => item.animated),
            items,
          };
        })
        .filter((pack) => (pack.items as unknown[]).length > 0);
    } catch {
      /* 目录不存在时输出空清单，前端表情按钮自然为空 */
    }

    return { generatedAt: new Date().toISOString(), packs };
  }

  return {
    name: "sticker-manifest",
    resolveId(id: string) {
      return id === STICKER_MANIFEST_ID ? resolvedId : null;
    },
    load(id: string) {
      if (id !== resolvedId) return null;
      return `export default ${JSON.stringify(collect())}`;
    },
  };
}

// ==================== Vite 插件：构建期生成开源致谢依赖清单与许可证 ====================
// 数据来自「实际安装的依赖副本」而不是 package.json 里的版本范围：致谢页要展示用户
// 真正拿到的代码，版本、许可证标识与原文都以磁盘上的安装目录为准。
//
// 三个虚拟模块分两层，关键是别把许可证全文塞进主清单：
// - virtual:credits 只有元数据（包名 / 版本 / 许可证标识 / 简介 / 链接），随页面一起加载；
// - virtual:credits-licenses 是「桶 → 动态 import」的映射，页面静态引用也几乎不占体积；
// - virtual:credits-licenses-<bucket> 才装许可证原文，打开某个包的抽屉时才下载它所在的那桶。
// 整份法律文本若和元数据同在 virtual:credits 里，同一模块内的字符串无法拆开 tree-shake，
// 首屏会多背几百 KB。
//
// 收集必须一次成型：清单、桶映射、各桶原文共享同一次扫描（缓存 Promise），
// 否则每次 load 都要把几百个包的 package.json 与许可证目录重读一遍。

const CREDITS_MANIFEST_ID = "virtual:credits";
const CREDITS_LICENSE_LOADERS_ID = "virtual:credits-licenses";
const CREDITS_LICENSE_BUCKET_PREFIX = "virtual:credits-licenses-";

/**
 * 单个许可证原文的大小上限。正常 LICENSE 几十 KB 封顶；上游偶尔把整份数据文件命名为
 * LICENSE / NOTICE，这种体积进前端产物只会拖慢页面，直接跳过（没有原文比塞进垃圾强）。
 */
const LICENSE_FILE_MAX_BYTES = 512 * 1024;

/** 安装副本 package.json 中本插件真正读取的字段（其余字段不进入产物）。 */
interface InstalledPackageManifest {
  name?: string;
  version?: string;
  license?: string;
  licenses?: Array<{ type?: string }>;
  description?: string;
  homepage?: string;
  repository?: string | { url?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface InstalledPackage {
  dir: string;
  manifest: InstalledPackageManifest;
}

/** 分桶产物：桶键 → 该桶的包名 → 许可证原文。 */
type LicenseBuckets = Record<string, CreditLicenseBucket>;

interface CollectedCredits {
  generatedAt: string;
  dependencies: CreditDependency[];
  buckets: LicenseBuckets;
}

/** 包简介折叠所有空白（含换行），再按契约上限截断；截断落在空格上时去掉尾随空格。 */
function shortenCreditDescription(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, CREDIT_DESCRIPTION_LIMIT).trimEnd();
}

/** 许可证标识：优先 SPDX 的 license 字段，兼容旧的 licenses 数组，都没有就是「未知」。 */
function readCreditLicense(manifest: InstalledPackageManifest): string {
  if (typeof manifest.license === "string" && manifest.license.trim())
    return manifest.license.trim();
  const legacyLicense = manifest.licenses?.[0]?.type;
  return typeof legacyLicense === "string" && legacyLicense.trim()
    ? legacyLicense.trim()
    : UNKNOWN_LICENSE;
}

/** repository 允许字符串或对象，统一取出原始地址交给归一化。 */
function readRepositoryUrl(repository: InstalledPackageManifest["repository"]): string {
  if (typeof repository === "string") return repository.trim();
  return typeof repository?.url === "string" ? repository.url.trim() : "";
}

/** npm 的宿主简写前缀 → 站点根。npm 只认 github / gitlab / bitbucket 三种简写。 */
const HOSTED_REPOSITORY_ROOTS = new Map([
  ["github", "https://github.com"],
  ["gitlab", "https://gitlab.com"],
  ["bitbucket", "https://bitbucket.org"],
]);

/**
 * 把 npm 清单里常见的 git 写法归一成能直接点开的 https 地址：
 * `git+https://…`、`git://…`、`git@github.com:owner/repo.git`、`ssh://git@…`、
 * `github:owner/repo` 与裸 `owner/repo` 简写都落到浏览器可访问的仓库页；
 * `.git` 后缀与尾部斜杠一并去掉。
 *
 * 认不出的形式一律返回空串：这类值直接当 `href` 输出会变成站内相对路径
 * （`sindresorhus/globals` → `/credits/sindresorhus/globals`），点开就是 404。
 */
function normalizeCreditRepositoryUrl(rawUrl: string): string {
  let url = rawUrl.trim().replace(/^git\+/, "");
  if (!url) return "";

  const hosted = /^(github|gitlab|bitbucket):(.+)$/i.exec(url);
  if (hosted) {
    const [, host = "", ownerAndRepo = ""] = hosted;
    const root = HOSTED_REPOSITORY_ROOTS.get(host.toLowerCase()) ?? "https://github.com";
    url = `${root}/${ownerAndRepo}`;
  } else if (/^[\w.-]+\/[\w.-]+$/.test(url)) {
    // 裸 `owner/repo`（sindresorhus/globals 这类）：npm 生态默认指 GitHub。
    url = `https://github.com/${url}`;
  }

  // scp 风格（git@host:path / git@host/path）：平台复制出来的仓库地址就是这种。
  const scpLike = /^git@([^:/]+)[:/](.+)$/.exec(url);
  if (scpLike) url = `https://${scpLike[1]}/${scpLike[2]}`;
  else if (url.startsWith("git://")) url = `https://${url.slice("git://".length)}`;
  else if (url.startsWith("ssh://")) url = url.replace(/^ssh:\/\/(?:git@)?/, "https://");

  const cleaned = url.replace(/\.git$/i, "").replace(/\/+$/, "");
  // 只放行绝对 http(s)：相对值留在页面上就是死链或站内跳转。
  return /^https?:\/\//i.test(cleaned) ? cleaned : "";
}

/**
 * 包链接：homepage 优先（只认绝对 http(s)），没有再退回 repository 归一化结果。
 * `homepage: "."`、`"docs/readme"` 这类相对值直接忽略。
 */
function readCreditUrl(manifest: InstalledPackageManifest): string {
  const homepage = typeof manifest.homepage === "string" ? manifest.homepage.trim() : "";
  if (/^https?:\/\//i.test(homepage)) return homepage;
  return normalizeCreditRepositoryUrl(readRepositoryUrl(manifest.repository));
}

/**
 * 许可证文件的展示顺序：主体许可证在前，补充声明在后。
 * 不能只按文件名排序：`NOTICE` 的字典序在 `LICENSE` 之前，先读补充声明没有意义。
 */
function licenseFileRank(fileName: string): number {
  const upperName = fileName.toUpperCase();
  if (upperName === "LICENSE") return 0;
  if (upperName === "LICENCE") return 1;
  if (upperName.startsWith("LICENSE")) return 2;
  if (upperName.startsWith("LICENCE")) return 3;
  if (upperName.startsWith("COPYING")) return 4;
  return 5;
}

export function creditsManifestPlugin(options: { clientDir?: string } = {}) {
  // 默认扫描 vite.config.ts 所在的 Client 目录；测试传入 os.tmpdir 下的夹具目录，
  // 不读本机真实安装。仓库根取 Client 的父目录，与 pnpm workspace 布局一致。
  const clientDir = path.resolve(options.clientDir ?? import.meta.dirname);
  const repoRootDir = path.dirname(clientDir);
  const nodeModulesDirs = [
    path.join(clientDir, "node_modules"),
    path.join(repoRootDir, "node_modules"),
    path.join(repoRootDir, "Server", "node_modules"),
  ];

  // 一次构建只扫一次盘：清单、桶映射与各桶原文共享同一份结果。
  // 存 Promise 而不是结果，并发的多个 load 也只会触发一次收集。
  let collected: Promise<CollectedCredits> | undefined;

  /** 包名 → 安装副本；`null` 表示缺包，缓存下来避免同一次收集里反复尝试解析。 */
  const installedPackages = new Map<string, InstalledPackage | null>();

  function readJsonFile<T>(filePath: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    } catch {
      return null;
    }
  }

  function isFile(filePath: string): boolean {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  /**
   * 找包目录。pnpm hoisted 布局把依赖放在仓库根，但 Client 自己的 node_modules 里
   * 也可能有不同版本（依赖冲突时），所以先按 Client → 仓库根 → Server 固定顺序直接
   * 看 package.json——很多包用 exports 只暴露入口，`require.resolve("<pkg>/package.json")`
   * 会直接失败，模块解析不能当主路径。
   *
   * 固定目录都没命中时再交给 Node 从引入方解析入口、沿目录上溯找同名 package.json：
   * 这条兜底覆盖「依赖装在仓库上层 node_modules」等非常规布局（本仓 hoisted 下用不到）。
   */
  function locateInstalledPackage(name: string, fromDir: string): string | null {
    for (const nodeModulesDir of nodeModulesDirs) {
      const packageDir = path.join(nodeModulesDir, ...name.split("/"));
      if (isFile(path.join(packageDir, "package.json"))) return packageDir;
    }

    try {
      const requireFrom = createRequire(path.join(fromDir, "package.json"));
      let currentDir = path.dirname(requireFrom.resolve(name));
      while (true) {
        const manifestPath = path.join(currentDir, "package.json");
        if (
          isFile(manifestPath) &&
          readJsonFile<InstalledPackageManifest>(manifestPath)?.name === name
        ) {
          return currentDir;
        }
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) return null;
        currentDir = parentDir;
      }
    } catch {
      return null;
    }
  }

  function readInstalledPackage(name: string, fromDir: string): InstalledPackage | null {
    if (installedPackages.has(name)) return installedPackages.get(name) ?? null;

    const packageDir = locateInstalledPackage(name, fromDir);
    const manifest = packageDir
      ? readJsonFile<InstalledPackageManifest>(path.join(packageDir, "package.json"))
      : null;
    const installed = packageDir && manifest ? { dir: packageDir, manifest } : null;
    installedPackages.set(name, installed);
    return installed;
  }

  /** 读取包根目录下的许可证类文件（不递归）；原文保持文件里的原始换行与空白。 */
  function readLicenseFiles(packageDir: string): CreditLicenseFile[] {
    try {
      return fs
        .readdirSync(packageDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
        .sort(
          (left, right) =>
            licenseFileRank(left.name) - licenseFileRank(right.name) ||
            left.name.localeCompare(right.name, "en")
        )
        .flatMap((entry) => {
          const filePath = path.join(packageDir, entry.name);
          try {
            // stat 与 read 之间文件被换掉的可能忽略：构建期读的是安装好的只读副本。
            if (fs.statSync(filePath).size > LICENSE_FILE_MAX_BYTES) return [];
            return [{ name: entry.name, text: fs.readFileSync(filePath, "utf-8") }];
          } catch {
            return [];
          }
        });
    } catch {
      // 目录读不了（权限等）就当这个包没有许可证原文，不能因此让整次构建挂掉。
      return [];
    }
  }

  /**
   * 闭包遍历：直接依赖 → dependencies + optionalDependencies 递归。
   * peerDependencies 不递归：peer 只是要求宿主已经装上，不是本包自己引入的代码，
   * 算进闭包会把同一份包重复归因到每条 peer 链。装好的 optional 依赖是真实依赖，照常递归；
   * 缺失的平台包直接跳过（缺失的可选依赖不会出现在清单里）。
   */
  function collectReachable(directNames: readonly string[], fromDir: string): Set<string> {
    const reachable = new Set<string>();
    // 队列带上「谁声明的它」：兜底模块解析要相对引入方进行，嵌套版本才不会串。
    const queue: Array<{ name: string; fromDir: string; optional: boolean }> = directNames.map(
      (name) => ({
        name,
        fromDir,
        optional: false,
      })
    );

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      if (reachable.has(item.name)) continue;
      reachable.add(item.name);

      const installed = readInstalledPackage(item.name, item.fromDir);
      if (!installed) {
        // 可选依赖缺失是常态（平台包只装当前平台那一个）；必需依赖缺失说明安装不完整，
        // 提示一条后跳过——致谢数据不该打挂整次构建。
        if (!item.optional) console.warn(`开源致谢：跳过未安装的依赖 ${item.name}`);
        continue;
      }

      for (const dependencyName of Object.keys(installed.manifest.dependencies ?? {})) {
        queue.push({ name: dependencyName, fromDir: installed.dir, optional: false });
      }
      for (const dependencyName of Object.keys(installed.manifest.optionalDependencies ?? {})) {
        queue.push({ name: dependencyName, fromDir: installed.dir, optional: true });
      }
    }

    return reachable;
  }

  async function collect(): Promise<CollectedCredits> {
    const clientManifestPath = path.join(clientDir, "package.json");
    const clientManifest = readJsonFile<InstalledPackageManifest>(clientManifestPath);
    if (!clientManifest) throw new Error(`开源致谢：读不到 ${clientManifestPath}`);

    // 直接依赖的 scope 按声明归类；同一个包同时声明在 dependencies 与 devDependencies 时
    // 按 runtime 处理——运行时确实会加载它。
    const directScopes = new Map<string, CreditScope>();
    for (const name of Object.keys(clientManifest.dependencies ?? {}))
      directScopes.set(name, "runtime");
    for (const name of Object.keys(clientManifest.devDependencies ?? {})) {
      if (!directScopes.has(name)) directScopes.set(name, "development");
    }

    const directNamesOf = (scope: CreditScope) =>
      [...directScopes].filter(([, declared]) => declared === scope).map(([name]) => name);
    const runtimeReachable = collectReachable(directNamesOf("runtime"), clientDir);
    const developmentReachable = collectReachable(directNamesOf("development"), clientDir);
    const scopeOf = (name: string): CreditScope =>
      runtimeReachable.has(name) ? "runtime" : "development";

    const dependencies: CreditDependency[] = [];
    const buckets: LicenseBuckets = {};
    const allNames = [...new Set([...runtimeReachable, ...developmentReachable])].sort(
      (left, right) => left.localeCompare(right, "en")
    );

    // 先收齐「确实安装」的包，再生成依赖图：清单里的子依赖必须指向本次构建里真实存在、
    // 且页面能点开详情的包，未安装的平台/可选包不能留在图里。
    const installedByName = new Map<string, InstalledPackage>();
    for (const name of allNames) {
      const installed = readInstalledPackage(name, clientDir);
      if (installed) installedByName.set(name, installed);
    }

    const childNamesOf = (installed: InstalledPackage): string[] => {
      const { manifest } = installed;
      const children = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ]);
      return [...children]
        .filter((child) => installedByName.has(child))
        .sort((left, right) => left.localeCompare(right, "en"));
    };

    for (const name of allNames) {
      const installed = installedByName.get(name);
      if (!installed) continue; // 缺包已在遍历时处理，这里不再重复告警

      const { manifest } = installed;
      dependencies.push({
        name: manifest.name ?? name,
        // 版本取安装副本，而不是 Client/package.json 里的版本范围。
        version: typeof manifest.version === "string" ? manifest.version : "",
        license: readCreditLicense(manifest),
        description:
          typeof manifest.description === "string"
            ? shortenCreditDescription(manifest.description)
            : "",
        url: readCreditUrl(manifest),
        direct: directScopes.has(name),
        // 两条依赖链都可达时 runtime 优先：生产运行时确实会加载的代码不该标成开发依赖。
        scope: scopeOf(name),
        // 页面一级只列直接依赖，二级抽屉靠这张图逐级展开子依赖。
        dependencies: childNamesOf(installed),
      });

      const bucket = licenseBucket(name);
      buckets[bucket] ??= {};
      buckets[bucket][name] = { files: readLicenseFiles(installed.dir) };
    }

    // 桶键排序后再写模块：产物与文件系统遍历顺序无关，构建可复现。
    const sortedBuckets: LicenseBuckets = {};
    for (const bucket of Object.keys(buckets).sort((left, right) =>
      left.localeCompare(right, "en")
    )) {
      sortedBuckets[bucket] = buckets[bucket];
    }

    return { generatedAt: new Date().toISOString(), dependencies, buckets: sortedBuckets };
  }

  function collectOnce(): Promise<CollectedCredits> {
    collected ??= collect();
    return collected;
  }

  function manifestModule(data: CollectedCredits): string {
    // 只写元数据：许可证原文留在桶模块里，否则打开页面就得下载全部法律文本。
    const manifest: CreditsManifest = {
      generatedAt: data.generatedAt,
      dependencies: data.dependencies,
    };
    return `export default ${JSON.stringify(manifest)}`;
  }

  function licenseLoadersModule(data: CollectedCredits): string {
    // 动态 import 保留静态字面量，打包器才能把每个桶拆成独立 chunk；
    // 页面静态 import 本模块时不会连带下载任何桶。
    // 动态 import 返回模块命名空间，这里解出 default 后才是契约里的 CreditLicenseBucket，
    // 调用方（CreditsLicenseLoader）不必知道虚拟模块的包装层。
    const entries = Object.keys(data.buckets).map(
      (bucket) =>
        `  ${JSON.stringify(bucket)}: () => import(${JSON.stringify(CREDITS_LICENSE_BUCKET_PREFIX + bucket)}).then((module) => module.default)`
    );
    return `export default {\n${entries.join(",\n")}\n}`;
  }

  function licenseBucketModule(bucket: CreditLicenseBucket): string {
    return `export default ${JSON.stringify(bucket)}`;
  }

  return {
    name: "credits-manifest",
    resolveId(id: string) {
      if (id === CREDITS_MANIFEST_ID || id === CREDITS_LICENSE_LOADERS_ID) return "\0" + id;
      // 桶键由 licenseBucket() 生成，只会是单个字母/数字（scoped 包取 scope 首字母）。
      // 只认这一种形状，别把 `virtual:credits-*` 的其它模块也接过来。
      if (!id.startsWith(CREDITS_LICENSE_BUCKET_PREFIX)) return null;
      const bucket = id.slice(CREDITS_LICENSE_BUCKET_PREFIX.length);
      return /^[a-z0-9#]$/.test(bucket) ? "\0" + id : null;
    },
    async load(id: string) {
      if (id === "\0" + CREDITS_MANIFEST_ID) return manifestModule(await collectOnce());
      if (id === "\0" + CREDITS_LICENSE_LOADERS_ID)
        return licenseLoadersModule(await collectOnce());

      if (id.startsWith("\0" + CREDITS_LICENSE_BUCKET_PREFIX)) {
        const bucket = id.slice(("\0" + CREDITS_LICENSE_BUCKET_PREFIX).length);
        const bucketData = (await collectOnce()).buckets[bucket];
        // 桶映射与桶模块同源，走不到这里说明有人绕开映射手写了 import，直接报错。
        if (!bucketData) throw new Error(`开源致谢：没有名为 ${bucket} 的许可证桶`);
        return licenseBucketModule(bucketData);
      }

      return null;
    },
  };
}

// ==================== Vite 插件：公共资源 WebP 流水线 ====================
// 目录重建与路径映射共用同一份状态，因此收在一个插件里：生成放在 config 钩子，
// 只有真正创建 dev server / 构建时执行。若放在配置函数顶层，任何 import 本文件的
// 工具（knip）都会在加载配置时重转码整站图片并递归删除 .generated-public。
//
// 映射允许源码中直接使用真实源文件路径（如 /assets/Faker.png），
// 开发模式下通过中间件自动透明 rewrite 到 .webp，
// 构建打包时通过 transform 自动改写 HTML 与代码中的路径至最终 .webp 产物。

export function publicWebpPlugin(prepare = preparePublicWebp) {
  let assetMap: Record<string, string> = {};

  const rewritePaths = (text: string) => {
    let transformed = text;
    for (const [sourcePath, targetPath] of Object.entries(assetMap)) {
      transformed = transformed.replaceAll(sourcePath, targetPath);
    }
    return transformed;
  };

  return {
    name: "public-webp",
    async config() {
      const prepared = await prepare();
      assetMap = prepared.assetMap;
      return { publicDir: prepared.publicDir };
    },
    configureServer(server: {
      middlewares: {
        use: (fn: (req: { url?: string }, _res: unknown, next: () => void) => void) => void;
      };
    }) {
      server.middlewares.use((req, _res, next) => {
        if (req.url) {
          const [pathname, query] = req.url.split("?");
          const target = assetMap[pathname];
          if (target) {
            req.url = target + (query ? `?${query}` : "");
          }
        }
        next();
      });
    },
    transformIndexHtml(html: string) {
      return rewritePaths(html)
        .replace(
          /<link\b([^>]*\brel=["']icon["'][^>]*\bhref=["'][^"']*\.webp["'][^>]*)>/gi,
          (match) => {
            return match.replace(/type=["']image\/[a-z0-9+]+["']/i, 'type="image/webp"');
          }
        )
        .replace(
          /<link\b([^>]*\bhref=["'][^"']*\.webp["'][^>]*\brel=["']icon["'][^>]*)>/gi,
          (match) => {
            return match.replace(/type=["']image\/[a-z0-9+]+["']/i, 'type="image/webp"');
          }
        );
    },
    transform(code: string, id: string) {
      if (id.includes("node_modules") || id.startsWith("\0")) return null;

      if (!Object.keys(assetMap).some((sourcePath) => code.includes(sourcePath))) return null;

      return {
        code: rewritePaths(code),
        map: null,
      };
    },
  };
}

// ==================== Vite 插件：静态外壳注入（可收录路由） ====================
// 本站是纯前端 SPA，构建产物的 <div id="root"> 是空的：执行 JS 的爬虫能自己渲染，
// 不执行 JS 的爬虫（百度为主）只能读到空壳。此插件在构建末尾把 PageMeta 里的正文与
// head 元信息写进各路由的 HTML，爬虫无需执行 JS 即可读到内容。
//
// 为什么是「构建期字符串注入」而不是无头浏览器预渲染：平台构建容器不提供 Chromium
// （实测报错 Executable doesn't exist ... chromium_headless_shell），而带着一个 150MB
// 的浏览器依赖去构建既慢又脆。本站可收录页面的正文本来就是数据（PageMeta），
// 直接由数据生成 HTML 更简单也更可靠。
//
// 注入的 head 标签全部带 data-static-seo="1"：这些标签只服务不执行 JS 的爬虫，
// 应用启动时会由 stripStaticSeo() 整体移除，再交给 react-helmet-async 写入当前路由的真值。
// 为什么不是「让 Helmet 接管」：react-helmet-async v3 在 React 19 下不走 DOM 复用路径
// （client.ts 里按 isEqualNode 复用旧标签的逻辑只在旧路径生效），它会直接渲染新标签，
// 静态标签留在原地就会变成重复 canonical —— 搜索引擎遇到重复 canonical 会判定整组失效。
// JSON-LD 例外：结构化数据与 FAQPage 各用一个固定 id，Seo 的 useEffect 按同一 id 覆盖内容，不产生重复。
//
// 正文外壳必须在**首次绘制之前**从执行 JS 的客户端里消失，否则用户进站会先看到一段裸文本。
// 入口是 defer 的 module 脚本（懒加载路由 chunk 还要再等一次网络），执行时机在首帧之后，
// 只靠它替换 #root 就会漏出这段文字。因此在外壳之后紧邻插入一段 parser-blocking 内联脚本，
// 随解析同步清空外壳：它被 <head> 里的渲染阻塞样式表挡住，必然早于首次绘制执行。
// 不执行 JS 的爬虫读的是原始 HTML，外壳照旧可见——两边的正文本来就是同一份。
//
// 为什么不用 `#root{display:none}` 之类的 CSS 兜底：那等于把正文标成隐藏文本，
// 在审核视角下与 hidden text 无异。此处不隐藏任何东西，只是让 JS 客户端先移除、再交给应用渲染。
// 也不用 <noscript>：目标恰恰是不执行 JS 的爬虫，而 noscript 里的内容在多数引擎眼中信号更弱。
const STATIC_SEO_ATTRIBUTE = "data-static-seo";
const STRUCTURED_DATA_ID = "bakagame-structured-data";
const FAQ_STRUCTURED_DATA_ID = "bakagame-faq-structured-data";
// 清空外壳的内联脚本（构建后必须存在，缺失即断言失败）
const SHELL_CLEAR_CODE = 'document.getElementById("root").replaceChildren()';

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// FAQ 是每页的必备内容：缺问答、空条目或重复问题，直接让构建失败——
// 这块内容用户不可见，坏了不会有任何观感反馈，只能靠断言拦在部署前。
function assertShellFaq(): void {
  for (const meta of PAGE_META) {
    if (meta.faq.length === 0) {
      throw new Error(`静态外壳：${meta.path} 缺少 FAQ 问答文案`);
    }
    const questions = new Set<string>();
    for (const item of meta.faq) {
      if (!item.q.trim() || !item.a.trim()) {
        throw new Error(`静态外壳：${meta.path} 的 FAQ 存在空问题或空答案`);
      }
      if (questions.has(item.q)) {
        throw new Error(`静态外壳：${meta.path} 的 FAQ 问题重复（${item.q}）`);
      }
      questions.add(item.q);
    }
  }
}

// 分享标语是所有登记页 description 的第一句：社媒卡片只展示前两行，
// 标语一旦被后文挤掉，分享出去的效果就直接退化——用断言把它钉死在构建前。
function assertShareDescription(): void {
  for (const meta of PAGE_META) {
    if (!meta.description.startsWith(SITE_TAGLINE)) {
      throw new Error(`静态外壳：${meta.path} 的描述未以分享标语「${SITE_TAGLINE}」开头`);
    }
  }
}

/** 单页静态外壳：在 index.html 原文上补齐 head 元信息与正文，并给出双形态落盘路径。 */
function buildShellPage(
  original: string,
  meta: PageMeta
): { path: string; html: string; outputs: string[] } {
  const canonical = `${SITE_ORIGIN}${meta.path}`;
  const description = escapeHtml(meta.description);
  const image = escapeHtml(meta.image ?? `${SITE_ORIGIN}/og/logo.jpg`);
  const faqStructuredData = buildFaqStructuredData(meta.faq);
  const head = [
    `<meta name="description" content="${description}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    ...(meta.keywords && meta.keywords.length > 0
      ? [
          `<meta name="keywords" content="${escapeHtml(meta.keywords.join(", "))}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
        ]
      : []),
    `<link rel="canonical" href="${canonical}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta name="robots" content="index,follow" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta property="og:type" content="website" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta property="og:title" content="${SITE_NAME}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta property="og:description" content="${description}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta property="og:image" content="${image}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta property="og:url" content="${canonical}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta name="twitter:card" content="summary_large_image" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta name="twitter:title" content="${SITE_NAME}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta name="twitter:description" content="${description}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta name="twitter:image" content="${image}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<script id="${STRUCTURED_DATA_ID}" type="application/ld+json">${JSON.stringify(meta.structuredData)}</script>`,
    ...(faqStructuredData
      ? [
          `<script id="${FAQ_STRUCTURED_DATA_ID}" type="application/ld+json">${JSON.stringify(faqStructuredData)}</script>`,
        ]
      : []),
  ].join("\n    ");

  const body = [
    `<h1>${escapeHtml(meta.shell.h1)}</h1>`,
    ...meta.shell.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    `<ul>${meta.shell.links
      .map((link) => `<li><a href="${link.href}">${escapeHtml(link.label)}</a></li>`)
      .join("")}</ul>`,
    `<section><h2>常见问题</h2>${meta.faq
      .map((item) => `<h3>${escapeHtml(item.q)}</h3><p>${escapeHtml(item.a)}</p>`)
      .join("")}</section>`,
  ].join("");

  const html = original
    .replace("</head>", `  ${head}\n  </head>`)
    .replace(
      '<div id="root"></div>',
      `<div id="root"><main>${body}</main></div>\n    <script>${SHELL_CLEAR_CODE}</script>`
    );

  const segment = meta.path.replace(/^\//, "").replace(/\/$/, "");
  return {
    path: meta.path,
    html,
    // 双形态落盘：目录索引型主机与 clean URL 型主机各覆盖一种，别名 canonical 指向正式路径。
    outputs: segment === "" ? ["index.html"] : [`${segment}/index.html`, `${segment}.html`],
  };
}

function staticShellPlugin() {
  return {
    name: "static-shell",
    apply: "build" as const,
    async closeBundle() {
      const distDir = path.resolve(import.meta.dirname, "dist");
      const indexPath = path.join(distDir, "index.html");
      const original = fs.readFileSync(indexPath, "utf8");

      // 注入点缺失时宁可让构建失败，也不要静默产出一个空壳站点。
      if (!original.includes('<div id="root"></div>')) {
        throw new Error("静态外壳：dist/index.html 里找不到空的 #root 容器");
      }
      if (!original.includes("</head>")) {
        throw new Error("静态外壳：dist/index.html 里找不到 </head>");
      }

      assertShellFaq();
      assertShareDescription();

      const pages = PAGE_META.map((meta) => buildShellPage(original, meta));

      // 先全部生成再落盘：index.html 同时是模板来源，边读边写会污染后续路由。
      for (const page of pages) {
        for (const output of page.outputs) {
          const target = path.join(distDir, output);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, page.html);
        }
        const primary = path.join(distDir, page.outputs[0]);
        const written = fs.readFileSync(primary, "utf8");
        for (const marker of [
          '<div id="root"><main>',
          SHELL_CLEAR_CODE,
          `${STATIC_SEO_ATTRIBUTE}="1"`,
          STRUCTURED_DATA_ID,
          FAQ_STRUCTURED_DATA_ID,
          "常见问题",
          SITE_TAGLINE,
        ]) {
          if (!written.includes(marker)) {
            throw new Error(`静态外壳：${page.outputs[0]} 缺少 ${marker}`);
          }
        }
      }

      console.log(`静态外壳注入完成：${pages.map((page) => page.path).join("、")}`);
    },
  };
}

// ==================== Vite 插件：SEO 产物生成（站点地图与分享图） ====================
// 两个产物、同一个来源：PageMeta。
//
// 站点地图曾手写在 public/sitemap.xml：新增可收录页面靠人记得同步，漏改没有任何报错，
// 而缺页只会让搜索引擎更晚发现新内容——静默漂移。改为构建末尾按 PAGE_META 生成，
// URL 集合回到单一真相源；lastmod 由各页在文案显著变更时手动维护，不随构建刷新
// （每次构建都变的 lastmod 会被搜索引擎判定不可信，进而整体忽略）。
//
// 分享图：全站图片管线只产 webp，而部分分享抓取器（QQ 实测）不认 webp，卡片显示不出图。
// 这里为 PageMeta.image 指向的每张站内分享图转制一份 jpg（/og/<名>.jpg，源图为
// public/assets 下的同名文件，png / jpg / gif / webp 均可；gif 取第一帧）。
// 外链分享图原样放行，不转制。

const OG_IMAGE_ROUTE = "/og/";
const OG_SOURCE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

function seoArtifactsPlugin() {
  return {
    name: "seo-artifacts",
    apply: "build" as const,
    async closeBundle() {
      const distDir = path.resolve(import.meta.dirname, "dist");

      // ---- 站点地图 ----
      const seenPaths = new Set<string>();
      for (const page of PAGE_META) {
        if (!page.path.startsWith("/")) {
          throw new Error(`SEO 产物：页面路径必须以 / 开头（${page.path}）`);
        }
        if (seenPaths.has(page.path)) {
          throw new Error(`SEO 产物：页面路径重复（${page.path}）`);
        }
        seenPaths.add(page.path);
        if (page.lastmod && !/^\d{4}-\d{2}-\d{2}$/.test(page.lastmod)) {
          throw new Error(`SEO 产物：${page.path} 的 lastmod 必须是 YYYY-MM-DD（${page.lastmod}）`);
        }
      }

      const sitemap = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...PAGE_META.map((page) =>
          [
            "  <url>",
            `    <loc>${SITE_ORIGIN}${page.path}</loc>`,
            ...(page.lastmod ? [`    <lastmod>${page.lastmod}</lastmod>`] : []),
            "    <changefreq>weekly</changefreq>",
            // priority 已被主流搜索引擎忽略，保留只是与既有的手写站点地图保持同构。
            `    <priority>${page.path === "/" ? "1.0" : "0.9"}</priority>`,
            "  </url>",
          ].join("\n")
        ),
        "</urlset>",
        "",
      ].join("\n");

      const sitemapPath = path.join(distDir, "sitemap.xml");
      fs.writeFileSync(sitemapPath, sitemap);

      // 回读逐条确认：登记过的页面一个都不许从站点地图里漏掉。
      const writtenSitemap = fs.readFileSync(sitemapPath, "utf8");
      for (const page of PAGE_META) {
        const loc = `<loc>${SITE_ORIGIN}${page.path}</loc>`;
        if (!writtenSitemap.includes(loc)) {
          throw new Error(`SEO 产物：站点地图缺少 ${loc}`);
        }
      }

      // ---- 分享图 ----
      const sourceDir = path.resolve(import.meta.dirname, "public/assets");
      const sourceFiles = fs.readdirSync(sourceDir);
      const ogPrefix = `${SITE_ORIGIN}${OG_IMAGE_ROUTE}`;

      const produced = await Promise.all(
        PAGE_META.map(async (page) => {
          const image = page.image;
          if (!image) return null;
          if (!image.startsWith(SITE_ORIGIN)) return null; // 外链分享图原样使用

          if (!image.startsWith(ogPrefix) || !image.endsWith(".jpg")) {
            console.warn(
              `SEO 产物：${page.path} 的分享图不在 /og/*.jpg 约定下（${image}），未转制——` +
                "部分分享抓取器（如 QQ）可能因格式不受支持而显示不出图。"
            );
            return null;
          }

          const name = image.slice(ogPrefix.length, -".jpg".length);
          const sourceFile = sourceFiles.find(
            (file) =>
              path.parse(file).name === name &&
              OG_SOURCE_EXTENSIONS.includes(path.extname(file).toLowerCase())
          );
          if (!sourceFile) {
            throw new Error(
              `SEO 产物：${page.path} 的分享图找不到同名源图（public/assets/${name}.*）`
            );
          }

          const target = path.join(distDir, "og", `${name}.jpg`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          // 分享卡片本来就是静态图：gif 源只取第一帧（sharp 默认行为）。
          await sharp(path.join(sourceDir, sourceFile)).jpeg({ quality: 88 }).toFile(target);

          if (fs.statSync(target).size === 0) {
            throw new Error(`SEO 产物：分享图 ${name}.jpg 是空文件`);
          }
          return `${OG_IMAGE_ROUTE}${name}.jpg`;
        })
      );
      const producedImages = produced.filter((item): item is string => item !== null);

      console.log(
        `SEO 产物生成完成：站点地图 ${PAGE_META.length} 条 URL、分享图 ${producedImages.length} 张（${producedImages.join("、")}）`
      );
    },
  };
}

export default defineConfig(({ command }) => {
  const emojiDir = path.resolve(import.meta.dirname, "./public/emojis");

  return {
    // publicDir 交给 public-webp 插件在 config 钩子里给出：只读取配置的工具
    // （knip）不再触发图片重转码，只有 dev server 与构建才会。
    // 图床与 /api 一样挂在后端进程上，两处都要转发：少一条 dev 环境的封面就全 404。
    server: {
      proxy: {
        "/api/bangumi": {
          target: "http://localhost:4850",
          changeOrigin: true,
        },
      },
    },
    // E2E 跑在 vite preview（生产构建）上：客户端生产包走同源相对路径，
    // preview 站内没有后端，把 /api（含 WebSocket 升级）转发给本地 Bun 服务。
    // 本地若存在 .env（VITE_SERVER_URL 指向 4850）则客户端直连，代理不参与。
    preview: {
      proxy: {
        "/api": {
          target: "http://localhost:4850",
          changeOrigin: true,
          ws: true,
        },
        // 图床前缀 `/api/bangumi` 已被上面这条 /api 规则覆盖，无需重复声明。
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      // 只有生产构建才走远端接口：开发期读本地 git 历史，离线可用且反映当前工作区。
      commitHistoryPlugin({ useRemote: command === "build" }),
      stickerManifestPlugin(emojiDir),
      creditsManifestPlugin(),
      publicWebpPlugin(),
      staticShellPlugin(),
      seoArtifactsPlugin(),
    ],
    resolve: {
      // 共享源码的运行依赖按客户端安装边界解析。独立安装的构建只在 Client 里
      // 装依赖：从 Server/src/shared 出发的裸导入必须落到这里的副本，
      // 否则打包阶段同样解析不到（与 tsconfig paths 是同一份边界的两侧）。
      dedupe: ["@sinclair/typebox", "@orpc/contract", "zod"],
      alias: [
        {
          find: "@bakagame/shared",
          replacement: path.resolve(import.meta.dirname, "../Server/src/shared/Index.ts"),
        },
        { find: "@/types", replacement: path.resolve(import.meta.dirname, "./src/types/Index.ts") },
        { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
      ],
    },
  };
});
