/** 收集依赖清单与许可证，生成致谢页虚拟模块。 */
import path from "path";
import fs from "fs";
import { createRequire } from "node:module";
import {
  CREDIT_DESCRIPTION_LIMIT,
  LICENSE_FILE_PATTERN,
  UNKNOWN_LICENSE,
  licenseBucket,
} from "../../src/lib/Credits.ts";
import {
  type CreditDependency,
  type CreditLicenseBucket,
  type CreditLicenseFile,
  type CreditsManifest,
  type CreditScope,
} from "../../src/lib/Credits.ts";

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
  // 默认扫描 Client 根目录（本文件在其下两级）；测试传入 os.tmpdir 下的夹具目录，
  // 不读本机真实安装。仓库根取 Client 的父目录，与 pnpm workspace 布局一致。
  const clientDir = path.resolve(options.clientDir ?? path.resolve(import.meta.dirname, "../.."));
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
