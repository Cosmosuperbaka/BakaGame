import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CREDIT_DESCRIPTION_LIMIT,
  UNKNOWN_LICENSE,
  licenseBucket,
  type CreditDependency,
  type CreditLicenseBucket,
  type CreditsManifest,
} from "./Credits";
import { creditsManifestPlugin } from "../../scripts/vite-plugins/CreditsManifest";

/**
 * 构建期致谢数据管线的回归测试。
 *
 * 这不是「插件能返回东西」的冒烟：插件在真实仓库里读到的是几百个已安装的包，
 * 断言一旦依赖当前安装树就会随依赖升级随机失效。所以这里在 os.tmpdir 下搭一个最小
 * pnpm workspace 布局（Client/package.json + Client、仓库根、Server 三处 node_modules），
 * 把闭包遍历、归类、可选依赖、许可证原文、分桶与缓存都钉在夹具上。
 * 夹具包的目录、版本、许可证原文全部由用例自己写入，改依赖不会影响这些断言。
 */

/** 夹具里的许可原文：逐字节断言，包含 CRLF 与结尾换行，验证「原文保持换行」。 */
const LICENSE_TEXTS = {
  alphaLicense: "MIT License\n\nCopyright (c) 2026 BakaGame\n",
  alphaNotice: "Alpha NOTICE\r\nsecond line\n",
  betaLicense: "beta license text\n",
  gammaLicence: "GNU LICENCE text\n",
  gammaCopying: "COPYING text\n",
  unknownLicense: "custom license text\n",
};

const MANIFEST_ID = "\0virtual:credits";
const LOADERS_ID = "\0virtual:credits-licenses";
const BUCKET_PREFIX = "virtual:credits-licenses-";

type CreditsPlugin = ReturnType<typeof creditsManifestPlugin>;

interface CreditsFixture {
  /** mkdtemp 出来的总目录，afterEach 整体删除。 */
  baseDir: string;
  clientDir: string;
  clientNodeModules: string;
  rootNodeModules: string;
  serverNodeModules: string;
  /** 仓库上层（baseDir 下）的 node_modules，只用于兜底模块解析的用例。 */
  upperNodeModules: string;
}

function writeTextFile(filePath: string, text: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function writeJsonFile(filePath: string, value: unknown) {
  writeTextFile(filePath, JSON.stringify(value, null, 2));
}

/** 在指定 node_modules 下安装一个包；licenseFiles 为「文件名 → 原文」。 */
function installPackage(
  nodeModulesDir: string,
  name: string,
  manifest: Record<string, unknown>,
  licenseFiles: Record<string, string> = {}
) {
  const packageDir = path.join(nodeModulesDir, ...name.split("/"));
  // 兜底模块解析走 require.resolve(name)：没有入口文件的包解析不到，夹具必须补一个。
  writeTextFile(path.join(packageDir, "index.js"), "module.exports = {};\n");
  writeJsonFile(path.join(packageDir, "package.json"), { name, version: "1.0.0", ...manifest });
  for (const [fileName, text] of Object.entries(licenseFiles)) {
    writeTextFile(path.join(packageDir, fileName), text);
  }
}

/**
 * 夹具依赖图：
 *
 *   Client dependencies: alpha-runtime, ordered-pick      devDependencies: beta-dev
 *   alpha  → gamma, server-located, upper-only, long-description, [optional] missing-platform-binary
 *   gamma  → delta-optional, shared-runtime-dev, unknown-license, [optional] optional-installed
 *   beta   → epsilon-dev-transitive, shared-runtime-dev
 *   epsilon → 五个链接归一化用例（shorthand-owner-repo、shorthand-hosted、hosted-gitlab-path、
 *             relative-homepage、unusable-url）
 *
 * shared-runtime-dev 同时可达两条链（runtime 优先）；peer-fake 已安装但不是闭包成员；
 * server-located 只装在 Server/node_modules；upper-only 只装在仓库上层 node_modules。
 */
function createCreditsFixture(): CreditsFixture {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "bakagame-credits-"));
  const rootDir = path.join(baseDir, "repo");
  const clientDir = path.join(rootDir, "Client");
  const fixture: CreditsFixture = {
    baseDir,
    clientDir,
    clientNodeModules: path.join(clientDir, "node_modules"),
    rootNodeModules: path.join(rootDir, "node_modules"),
    serverNodeModules: path.join(rootDir, "Server", "node_modules"),
    upperNodeModules: path.join(baseDir, "node_modules"),
  };

  writeJsonFile(path.join(clientDir, "package.json"), {
    name: "client",
    dependencies: {
      "alpha-runtime": "^2.0.0",
      "ordered-pick": "^1.0.0",
    },
    devDependencies: {
      "beta-dev": "^4.0.0",
    },
  });

  installPackage(
    fixture.rootNodeModules,
    "alpha-runtime",
    {
      version: "2.1.0",
      license: "MIT",
      description: "  Runtime   package\nwith   whitespace \n",
      homepage: "https://example.com/alpha",
      repository: { type: "git", url: "git+https://github.com/example/alpha.git" },
      dependencies: {
        "gamma-transitive": "^1.0.0",
        "server-located": "^1.0.0",
        "upper-only": "^1.0.0",
        "long-description": "^1.0.0",
      },
      optionalDependencies: { "missing-platform-binary": "^1.0.0" },
    },
    {
      LICENSE: LICENSE_TEXTS.alphaLicense,
      NOTICE: LICENSE_TEXTS.alphaNotice,
      "README.md": "# 不是许可证文件\n",
    }
  );

  installPackage(
    fixture.rootNodeModules,
    "gamma-transitive",
    {
      version: "3.2.1",
      licenses: [{ type: "Apache-2.0" }],
      description: "Gamma",
      repository: "git+https://github.com/example/gamma.git",
      dependencies: {
        "delta-optional": "^1.0.0",
        "shared-runtime-dev": "^1.0.0",
        "unknown-license": "^1.0.0",
      },
      optionalDependencies: { "optional-installed": "^1.0.0" },
      peerDependencies: { "peer-fake": "^1.0.0" },
    },
    { LICENCE: LICENSE_TEXTS.gammaLicence, COPYING: LICENSE_TEXTS.gammaCopying }
  );

  installPackage(fixture.rootNodeModules, "delta-optional", {
    version: "1.2.3",
    license: "BSD-3-Clause",
    repository: "git://github.com/example/delta.git",
  });
  installPackage(fixture.rootNodeModules, "optional-installed", {
    version: "0.5.0",
    license: "MIT",
  });
  installPackage(fixture.rootNodeModules, "shared-runtime-dev", {
    version: "6.6.6",
    license: "ISC",
  });
  installPackage(
    fixture.rootNodeModules,
    "unknown-license",
    { version: "0.0.1" },
    { license: LICENSE_TEXTS.unknownLicense }
  );
  installPackage(fixture.rootNodeModules, "long-description", {
    version: "1.0.0",
    license: "MIT",
    description: "a".repeat(CREDIT_DESCRIPTION_LIMIT + 40),
  });

  // 只装在 Server 与仓库上层 node_modules 的包：验证固定目录兜底与 Node 解析兜底。
  installPackage(fixture.serverNodeModules, "server-located", { version: "7.0.0", license: "MIT" });
  installPackage(fixture.upperNodeModules, "upper-only", { version: "8.0.0", license: "MIT" });

  // 同名包双版本：Client 自己的 node_modules 优先于仓库根。
  installPackage(fixture.clientNodeModules, "ordered-pick", { version: "1.0.0", license: "MIT" });
  installPackage(fixture.rootNodeModules, "ordered-pick", { version: "9.9.9", license: "MIT" });

  // 开发链：beta-dev → epsilon（许可证原文超大，应被跳过）+ shared（与运行时链共享）。
  installPackage(
    fixture.rootNodeModules,
    "beta-dev",
    {
      version: "4.0.0",
      license: "MIT",
      repository: { type: "git", url: "git@github.com:example/beta-dev.git" },
      dependencies: { "epsilon-dev-transitive": "^0.9.0", "shared-runtime-dev": "^1.0.0" },
      peerDependencies: { "peer-fake": "^1.0.0" },
    },
    { "LICENSE.txt": LICENSE_TEXTS.betaLicense }
  );
  installPackage(
    fixture.rootNodeModules,
    "epsilon-dev-transitive",
    {
      version: "5.5.5",
      license: "MIT",
      // 链接归一化的输入：裸 owner/repo、宿主简写、gitlab 多级路径、相对 homepage 与认不出的写法。
      dependencies: {
        "hosted-gitlab-path": "^1.0.0",
        "relative-homepage": "^1.0.0",
        "shorthand-hosted": "^1.0.0",
        "shorthand-owner-repo": "^1.0.0",
        "unusable-url": "^1.0.0",
      },
    },
    { LICENSE: "x".repeat(2 * 1024 * 1024) }
  );
  installPackage(fixture.rootNodeModules, "shorthand-owner-repo", {
    version: "1.0.0",
    license: "MIT",
    repository: "sindresorhus/globals",
  });
  installPackage(fixture.rootNodeModules, "shorthand-hosted", {
    version: "1.0.0",
    license: "MIT",
    repository: "github:example/hosted-pkg",
  });
  installPackage(fixture.rootNodeModules, "hosted-gitlab-path", {
    version: "1.0.0",
    license: "MIT",
    repository: "gitlab:example/sub/pkg",
  });
  installPackage(fixture.rootNodeModules, "relative-homepage", {
    version: "1.0.0",
    license: "MIT",
    homepage: "docs/readme",
    repository: { type: "git", url: "https://github.com/example/relative-homepage" },
  });
  installPackage(fixture.rootNodeModules, "unusable-url", {
    version: "1.0.0",
    license: "MIT",
    homepage: "see the readme",
    repository: "not a repo ref",
  });
  installPackage(fixture.rootNodeModules, "peer-fake", { version: "1.0.0", license: "MIT" });
  installPackage(fixture.rootNodeModules, "unrelated-package", {
    version: "1.0.0",
    license: "MIT",
  });

  return fixture;
}

/** 虚拟模块产物应当是 `export default <JSON>`，取回对象才能断言。 */
async function loadVirtualModule(plugin: CreditsPlugin, resolvedId: string): Promise<unknown> {
  const code = await plugin.load(resolvedId);
  if (typeof code !== "string") throw new Error(`虚拟模块 ${resolvedId} 没有输出内容`);

  const prefix = "export default ";
  if (!code.startsWith(prefix)) throw new Error(`虚拟模块 ${resolvedId} 不是 export default 形式`);
  return JSON.parse(code.slice(prefix.length));
}

async function loadCreditsManifest(plugin: CreditsPlugin): Promise<CreditsManifest> {
  return (await loadVirtualModule(plugin, MANIFEST_ID)) as CreditsManifest;
}

function dependencyOf(manifest: CreditsManifest, name: string): CreditDependency {
  const dependency = manifest.dependencies.find((item) => item.name === name);
  if (!dependency) throw new Error(`清单里没有 ${name}`);
  return dependency;
}

async function loadLicenseBucket(
  plugin: CreditsPlugin,
  bucket: string
): Promise<CreditLicenseBucket> {
  const specifier = BUCKET_PREFIX + bucket;
  expect(plugin.resolveId(specifier)).toBe("\0" + specifier);
  return (await loadVirtualModule(plugin, "\0" + specifier)) as CreditLicenseBucket;
}

/** 从 loaders 虚拟模块源码里取出「桶 → import 说明符」，数组顺序即生成顺序。 */
function parseLoaderEntries(code: string): Array<{ bucket: string; specifier: string }> {
  return [
    ...code.matchAll(/"([a-z0-9#]+)": \(\) => import\("(virtual:credits-licenses-[a-z0-9#]+)"\)/g),
  ].map((match) => {
    const [, bucket = "", specifier = ""] = match;
    return { bucket, specifier };
  });
}

const compareNames = (left: string, right: string) => left.localeCompare(right, "en");

describe("creditsManifestPlugin", () => {
  let fixture: CreditsFixture;
  let plugin: CreditsPlugin;

  beforeEach(() => {
    fixture = createCreditsFixture();
    plugin = creditsManifestPlugin({ clientDir: fixture.clientDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(fixture.baseDir, { recursive: true, force: true });
  });

  it("插件名与同文件其它插件不冲突", () => {
    expect(plugin.name).toBe("credits-manifest");
  });

  describe("虚拟模块解析", () => {
    it("resolveId 只认自己的三个模块", () => {
      expect(plugin.resolveId("virtual:credits")).toBe(MANIFEST_ID);
      expect(plugin.resolveId("virtual:credits-licenses")).toBe(LOADERS_ID);
      expect(plugin.resolveId(`${BUCKET_PREFIX}a`)).toBe(`\0${BUCKET_PREFIX}a`);

      // 同文件其它插件的虚拟模块不能被接管。
      expect(plugin.resolveId("virtual:commit-history")).toBeNull();
      expect(plugin.resolveId("virtual:sticker-manifest")).toBeNull();
      expect(plugin.resolveId("virtual:credits-extra")).toBeNull();
      // 桶键固定为单字符，非法桶名不解析，交给 Vite 报「找不到模块」。
      expect(plugin.resolveId(`${BUCKET_PREFIX}aa`)).toBeNull();
    });

    it("load 对外部模块返回 null，对未知桶直接报错", async () => {
      expect(await plugin.load("\0virtual:sticker-manifest")).toBeNull();
      expect(await plugin.load("\0virtual:unknown")).toBeNull();
      await expect(plugin.load(`\0${BUCKET_PREFIX}z`)).rejects.toThrow(/没有名为 z 的许可证桶/);
    });
  });

  describe("依赖闭包与归类", () => {
    it("直接依赖按声明归类，传递依赖沿依赖链归类", async () => {
      const manifest = await loadCreditsManifest(plugin);
      expect(manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      expect(dependencyOf(manifest, "alpha-runtime")).toMatchObject({
        direct: true,
        scope: "runtime",
      });
      expect(dependencyOf(manifest, "ordered-pick")).toMatchObject({
        direct: true,
        scope: "runtime",
      });
      expect(dependencyOf(manifest, "beta-dev")).toMatchObject({
        direct: true,
        scope: "development",
      });
      expect(dependencyOf(manifest, "gamma-transitive")).toMatchObject({
        direct: false,
        scope: "runtime",
      });
      expect(dependencyOf(manifest, "delta-optional")).toMatchObject({
        direct: false,
        scope: "runtime",
      });
      expect(dependencyOf(manifest, "epsilon-dev-transitive")).toMatchObject({
        direct: false,
        scope: "development",
      });
    });

    it("runtime 与 development 两条链都可达时归 runtime", async () => {
      const manifest = await loadCreditsManifest(plugin);
      expect(dependencyOf(manifest, "shared-runtime-dev")).toMatchObject({
        direct: false,
        scope: "runtime",
      });
    });

    it("递归 optionalDependencies，缺失的平台包直接跳过", async () => {
      const manifest = await loadCreditsManifest(plugin);
      // 装上了的可选依赖也是真实依赖，照常递归。
      expect(dependencyOf(manifest, "optional-installed")).toMatchObject({ scope: "runtime" });
      // 未安装的平台包不出现，且不会让收集失败。
      expect(manifest.dependencies.map((item) => item.name)).not.toContain(
        "missing-platform-binary"
      );
    });

    it("不递归 peerDependencies", async () => {
      const manifest = await loadCreditsManifest(plugin);
      // peer-fake 已安装在仓库根，但它只是 beta-dev 的 peer，不应进入清单。
      expect(manifest.dependencies.map((item) => item.name)).not.toContain("peer-fake");
    });

    it("每个包带一张子依赖图：只收本次真实安装、能被抽屉点开的包", async () => {
      const manifest = await loadCreditsManifest(plugin);
      // 依赖声明里有 missing-platform-binary，但它没安装：不进图，否则二级抽屉会点到空条目。
      expect(dependencyOf(manifest, "alpha-runtime").dependencies).toEqual([
        "gamma-transitive",
        "long-description",
        "server-located",
        "upper-only",
      ]);
      // optionalDependencies 与实际 dependencies 合并、排序；peer 不进图。
      expect(dependencyOf(manifest, "gamma-transitive").dependencies).toEqual([
        "delta-optional",
        "optional-installed",
        "shared-runtime-dev",
        "unknown-license",
      ]);
      expect(dependencyOf(manifest, "beta-dev").dependencies).toEqual([
        "epsilon-dev-transitive",
        "shared-runtime-dev",
      ]);
      // 叶子包给空数组，页面据此显示「无子依赖」。
      expect(dependencyOf(manifest, "ordered-pick").dependencies).toEqual([]);
      // 图里的每个名字都必须在清单里存在，页面才不用处理悬空引用。
      const names = new Set(manifest.dependencies.map((item) => item.name));
      for (const dependency of manifest.dependencies) {
        for (const child of dependency.dependencies) expect(names.has(child)).toBe(true);
      }
    });

    it("只收集 Client 的直接依赖闭包，未引用的安装包不出现", async () => {
      const manifest = await loadCreditsManifest(plugin);
      expect(manifest.dependencies.map((item) => item.name)).not.toContain("unrelated-package");
    });

    it("按 Client → 仓库根 → Server 的 node_modules 顺序找安装副本", async () => {
      const manifest = await loadCreditsManifest(plugin);
      // 同名包在 Client/node_modules 与仓库根各有一份，Client 的那份优先。
      expect(dependencyOf(manifest, "ordered-pick")).toMatchObject({ version: "1.0.0" });
      // 只装在 Server/node_modules 的包仍能被解析到（workspace 布局兜底）。
      expect(dependencyOf(manifest, "server-located")).toMatchObject({ version: "7.0.0" });
    });

    it("固定目录都找不到时兜底 Node 模块解析", async () => {
      const manifest = await loadCreditsManifest(plugin);
      // upper-only 只装在仓库上层 node_modules，三个固定目录都没有，只能靠 Node 解析。
      expect(dependencyOf(manifest, "upper-only")).toMatchObject({
        version: "8.0.0",
        direct: false,
      });
    });

    it("按包名排序且不重复，版本取安装副本", async () => {
      const manifest = await loadCreditsManifest(plugin);
      const names = manifest.dependencies.map((item) => item.name);
      expect(names).toEqual([...names].sort(compareNames));
      expect(new Set(names).size).toBe(names.length);
      // Client 声明的是 ^1.0.0 范围，清单里必须是安装副本的 3.2.1。
      expect(dependencyOf(manifest, "gamma-transitive").version).toBe("3.2.1");
    });
  });

  describe("元数据", () => {
    it("license 优先 license 字段，兼容 licenses[0].type，否则 UNKNOWN", async () => {
      const manifest = await loadCreditsManifest(plugin);
      expect(dependencyOf(manifest, "alpha-runtime").license).toBe("MIT");
      expect(dependencyOf(manifest, "gamma-transitive").license).toBe("Apache-2.0");
      expect(dependencyOf(manifest, "unknown-license").license).toBe(UNKNOWN_LICENSE);
    });

    it("description 折叠空白并按上限截断", async () => {
      const manifest = await loadCreditsManifest(plugin);
      expect(dependencyOf(manifest, "alpha-runtime").description).toBe(
        "Runtime package with whitespace"
      );
      const longDescription = dependencyOf(manifest, "long-description").description;
      expect(longDescription).toHaveLength(CREDIT_DESCRIPTION_LIMIT);
      expect(longDescription).toBe("a".repeat(CREDIT_DESCRIPTION_LIMIT));
      expect(dependencyOf(manifest, "unknown-license").description).toBe("");
    });

    it("url 优先 homepage，其次 repository 并归一成 https", async () => {
      const manifest = await loadCreditsManifest(plugin);
      // homepage 与 repository 都有时取 homepage。
      expect(dependencyOf(manifest, "alpha-runtime").url).toBe("https://example.com/alpha");
      // git+https://… 去掉 git+ 与 .git 后缀。
      expect(dependencyOf(manifest, "gamma-transitive").url).toBe(
        "https://github.com/example/gamma"
      );
      // git@host:owner/repo.git 归一成 https。
      expect(dependencyOf(manifest, "beta-dev").url).toBe("https://github.com/example/beta-dev");
      // git:// 协议也归一成 https。
      expect(dependencyOf(manifest, "delta-optional").url).toBe("https://github.com/example/delta");
      // 都没有时为空串。
      expect(dependencyOf(manifest, "unknown-license").url).toBe("");
    });

    it("repository 简写归一成绝对地址，认不出的写法给空串", async () => {
      const manifest = await loadCreditsManifest(plugin);
      // 裸 owner/repo（sindresorhus/globals 这类）：不能原样输出，否则 href 是站内相对路径。
      expect(dependencyOf(manifest, "shorthand-owner-repo").url).toBe(
        "https://github.com/sindresorhus/globals"
      );
      // github:owner/repo 宿主简写。
      expect(dependencyOf(manifest, "shorthand-hosted").url).toBe(
        "https://github.com/example/hosted-pkg"
      );
      // gitlab: 的多级路径（group/sub/repo）原样保留在 host 之后。
      expect(dependencyOf(manifest, "hosted-gitlab-path").url).toBe(
        "https://gitlab.com/example/sub/pkg"
      );
      // homepage 不是绝对地址时忽略，退回 repository。
      expect(dependencyOf(manifest, "relative-homepage").url).toBe(
        "https://github.com/example/relative-homepage"
      );
      // 两种写法都认不出：空串，页面据此不渲染「项目主页」，也不生成死链。
      expect(dependencyOf(manifest, "unusable-url").url).toBe("");
      // 清单里任何 url 都必须是绝对 http(s)，页面直接当 href 用。
      for (const dependency of manifest.dependencies) {
        expect(dependency.url === "" || /^https?:\/\//.test(dependency.url), dependency.name).toBe(
          true
        );
      }
    });
  });

  describe("许可证原文", () => {
    it("读取包根目录的许可证类文件，忽略 README，保留原始换行", async () => {
      const bucket = await loadLicenseBucket(plugin, licenseBucket("alpha-runtime"));
      expect(bucket["alpha-runtime"].files).toEqual([
        { name: "LICENSE", text: LICENSE_TEXTS.alphaLicense },
        { name: "NOTICE", text: LICENSE_TEXTS.alphaNotice },
      ]);
    });

    it("LICENSE 主体排在 COPYING / NOTICE 补充声明之前", async () => {
      const bucket = await loadLicenseBucket(plugin, licenseBucket("gamma-transitive"));
      expect(bucket["gamma-transitive"].files.map((file) => file.name)).toEqual([
        "LICENCE",
        "COPYING",
      ]);
    });

    it("文件名匹配不区分大小写，没有许可证文件的包给空数组", async () => {
      const unknownBucket = await loadLicenseBucket(plugin, licenseBucket("unknown-license"));
      expect(unknownBucket["unknown-license"].files.map((file) => file.name)).toEqual(["license"]);

      const deltaBucket = await loadLicenseBucket(plugin, licenseBucket("delta-optional"));
      expect(deltaBucket["delta-optional"].files).toEqual([]);
    });

    it("超大许可证文件直接跳过，不塞进前端产物", async () => {
      const bucket = await loadLicenseBucket(plugin, licenseBucket("epsilon-dev-transitive"));
      expect(bucket["epsilon-dev-transitive"].files).toEqual([]);
    });
  });

  describe("按首字母分桶的懒加载模块", () => {
    it("loaders 只导出「桶 → 动态 import」映射，按桶键排序", async () => {
      const code = await plugin.load(LOADERS_ID);
      expect(typeof code).toBe("string");
      const entries = parseLoaderEntries(String(code));

      const manifest = await loadCreditsManifest(plugin);
      const expectedBuckets = [
        ...new Set(manifest.dependencies.map((item) => licenseBucket(item.name))),
      ].sort(compareNames);
      expect(entries.map((entry) => entry.bucket)).toEqual(expectedBuckets);
      for (const entry of entries) {
        expect(entry.specifier).toBe(BUCKET_PREFIX + entry.bucket);
      }
      // 动态 import 返回模块命名空间；生成的 loader 必须自己解出 default，
      // 契约里的 loader 才是「直接给出桶」而不是「给出 { default: 桶 }」。
      const unwrap = String(code).match(/\.then\(\(module\) => module\.default\)/g) ?? [];
      expect(unwrap).toHaveLength(entries.length);
    });

    it("每个桶只含落在该桶的包，整桶可取出原文", async () => {
      const manifest = await loadCreditsManifest(plugin);
      const expectedByBucket = new Map<string, string[]>();
      for (const dependency of manifest.dependencies) {
        const bucket = licenseBucket(dependency.name);
        const names = expectedByBucket.get(bucket) ?? [];
        names.push(dependency.name);
        expectedByBucket.set(bucket, names);
      }

      for (const [bucket, names] of expectedByBucket) {
        const document = await loadLicenseBucket(plugin, bucket);
        expect(Object.keys(document)).toEqual(names);
        for (const name of names) expect(licenseBucket(name)).toBe(bucket);
      }
    });

    it("许可证原文只在桶模块里，主清单与 loaders 都不带法律文本", async () => {
      const manifestCode = await plugin.load(MANIFEST_ID);
      const loadersCode = await plugin.load(LOADERS_ID);
      expect(typeof manifestCode).toBe("string");
      expect(typeof loadersCode).toBe("string");

      for (const text of Object.values(LICENSE_TEXTS)) {
        expect(manifestCode).not.toContain(text);
        expect(loadersCode).not.toContain(text);
      }
      // 主清单也不该带原文文件列表字段（那是桶模块的形状）。
      expect(manifestCode).not.toContain('"files"');
    });
  });

  describe("性能", () => {
    it("一次构建只收集一次，三个虚拟模块共享缓存", async () => {
      // 收集的代价主要在每个包的 package.json 与许可证目录读取，统计目录读取次数即可：
      // 第二次 load 要么命中缓存，要么会把夹具目录再扫一遍。
      const readdirSpy = vi.spyOn(fs, "readdirSync");

      const code = await plugin.load(MANIFEST_ID);
      expect(typeof code).toBe("string");
      const readsAfterFirstCollect = readdirSpy.mock.calls.length;
      expect(readsAfterFirstCollect).toBeGreaterThan(0);

      await plugin.load(MANIFEST_ID);
      await plugin.load(LOADERS_ID);
      await plugin.load(`\0${BUCKET_PREFIX}${licenseBucket("alpha-runtime")}`);

      expect(readdirSpy.mock.calls).toHaveLength(readsAfterFirstCollect);
    });
  });
});
