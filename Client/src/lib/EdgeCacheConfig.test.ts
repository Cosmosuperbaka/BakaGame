import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 边缘缓存配置的回归守卫。
 *
 * `Client/edgeone.json` 是边缘响应头与边缘缓存配置的唯一真相源，
 * 但它是纯数据文件：写错了不会有类型检查、不会有构建报错，只会在线上
 * 表现为「发版后老用户拿到旧页面」或「静态资源反复回源」。这里把
 * 岗位约定固化成断言，改错配置时当场失败。
 *
 * 规则来源见 Agents/Deployment.md §5「边缘缓存策略」。
 */

const configPath = path.resolve(__dirname, "../../edgeone.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  headers?: Array<{ source: string; headers?: Array<{ key: string; value: string }> }>;
  caches?: Array<{ source: string; cacheTtl: number }>;
};

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

const headerRules: HeaderRule[] = (config.headers ?? []).map((rule) => ({
  source: rule.source,
  headers: rule.headers ?? [],
}));

/** 平台上限：headers 规则数最多 30。 */
const MAX_HEADER_RULES = 30;

/** 无内容哈希、必须短缓存的固定名资源（与 dist/assets 下的实际文件对应）。 */
const UNHASHED_ASSETS = ["CEE.webp", "Faker.webp", "favicon.webp", "logo.webp", "SongGuessr.webp"];

function cacheControlFor(rule: HeaderRule): string | undefined {
  return rule.headers.find((header) => header.key.toLowerCase() === "cache-control")?.value;
}

/** 取第一个匹配该路径的规则——平台按书写顺序匹配，先命中者生效。 */
function resolveCacheControl(urlPath: string): string | undefined {
  for (const rule of headerRules) {
    if (matchesSource(rule.source, urlPath)) return cacheControlFor(rule);
  }
  return undefined;
}

/**
 * 复刻平台的 source 匹配语义（见 edgeone.json 文档「URL Path Matching Rules」）：
 *  - 精确路径：`/sitemap.xml`
 *  - 占位符：`/articles/:id`
 *  - 通配符：`/assets/*` 匹配其下任意内容
 *  - 带后缀的通配符：`/assets/*.js` 匹配该目录下所有 .js
 * 一个 source 最多含一个 `*`；`*` 是 URL 路径通配符，不是文件系统 glob。
 */
function matchesSource(source: string, urlPath: string): boolean {
  const star = source.indexOf("*");
  if (star === -1) {
    // 无通配符：先按字面比，再支持 `:param` 单级占位。
    if (source === urlPath) return true;
    if (!source.includes(":")) return false;
    const sourceParts = source.split("/");
    const pathParts = urlPath.split("/");
    if (sourceParts.length !== pathParts.length) return false;
    return sourceParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
  }

  const prefix = source.slice(0, star);
  const suffix = source.slice(star + 1);
  return (
    urlPath.startsWith(prefix) &&
    urlPath.endsWith(suffix) &&
    urlPath.length >= prefix.length + suffix.length
  );
}

describe("edgeone.json 边缘缓存配置", () => {
  it("是合法 JSON 且规则数在上限内", () => {
    expect(Array.isArray(config.headers)).toBe(true);
    expect(headerRules.length).toBeGreaterThan(0);
    expect(headerRules.length).toBeLessThanOrEqual(MAX_HEADER_RULES);
  });

  it("每条规则都带 source 与非空 headers，且 header key 不重复", () => {
    for (const rule of headerRules) {
      expect(rule.source, "source 不得为空").toBeTruthy();
      expect(rule.source.startsWith("/"), `${rule.source} 必须以 / 开头`).toBe(true);
      expect(rule.headers.length, `${rule.source} 的 headers 不得为空`).toBeGreaterThan(0);
      const keys = rule.headers.map((header) => header.key.toLowerCase());
      expect(new Set(keys).size, `${rule.source} 内 header key 重复`).toBe(keys.length);
    }
  });

  it("SPA 外壳 HTML 一律走协商缓存，绝不长时间缓存", () => {
    // 首页与各路由外壳都是不带 hash 的 HTML，长缓存会让发版后老用户拿到旧页面。
    for (const route of ["/", "/whoisfaker", "/songuessr", "/cee", "/songuessr.html"]) {
      const value = resolveCacheControl(route);
      expect(value, `${route} 命中不到任何规则`).toBeTruthy();
      expect(value, `${route} 不应被长时间缓存`).toMatch(/max-age=0|no-cache|no-store/);
      expect(value, `${route} 不得使用 immutable`).not.toContain("immutable");
    }
  });

  it("房间页同样不得被边缘长时间缓存", () => {
    for (const route of ["/whoisfaker/room/123", "/songuessr/room/456", "/cee/room/789"]) {
      const value = resolveCacheControl(route);
      expect(value, `${route} 不应被长时间缓存`).toMatch(/max-age=0|no-cache|no-store/);
    }
  });

  it("带内容哈希的构建产物按不变资源长期缓存", () => {
    for (const asset of [
      "/assets/index-tr6SU87_.js",
      "/assets/index-2xJxDFL9.css",
      "/assets/lxgw-wenkai-sans-400-00.woff2",
    ]) {
      expect(resolveCacheControl(asset), `${asset} 应长期 immutable`).toContain("immutable");
    }
  });

  it("表情包贴纸是内容寻址的，按不变资源长期缓存", () => {
    expect(resolveCacheControl("/stickers/07d4bad0cd15985ae12b6d6f.webp")).toContain("immutable");
  });

  it("固定名图片不得 immutable——它们没有内容哈希，改图后无法失效", () => {
    // 这条是配置里最容易踩的坑：/assets/*.webp 既覆盖带 hash 的产物，
    // 也覆盖这 5 个固定名图片。按 hash 与不按 hash 的必须分档。
    for (const name of UNHASHED_ASSETS) {
      const value = resolveCacheControl(`/assets/${name}`);
      expect(value, `/assets/${name} 命中不到规则`).toBeTruthy();
      expect(value, `/assets/${name} 无内容哈希，不得 immutable`).not.toContain("immutable");
      expect(value, `/assets/${name} 仍应被缓存以减少回源`).toMatch(/max-age=[1-9]/);
    }
  });

  it("兜底规则 /* 必须排在最后——平台按书写顺序取首个命中，宽泛规则前置会吞掉所有具体规则", () => {
    const genericAt = headerRules.findIndex((rule) => rule.source === "/*");
    expect(genericAt, "缺少 /* 兜底规则").toBeGreaterThanOrEqual(0);
    expect(genericAt, "/* 必须排最后").toBe(headerRules.length - 1);
  });

  it("每条具体规则都能真正命中，不被前置的宽泛规则屏蔽", () => {
    // 这是配置里最隐蔽的坑：规则顺序错了，JSON 依然合法、平台也接受，
    // 只是所有具体规则静默失效。用「探测路径必须拿到自己那档策略」来锁死。
    const probes: Array<[string, RegExp]> = [
      ["/assets/index-tr6SU87_.js", /immutable/],
      ["/assets/index-2xJxDFL9.css", /immutable/],
      ["/assets/lxgw-wenkai-sans-400-00.woff2", /immutable/],
      ["/stickers/07d4bad0cd15985ae12b6d6f.webp", /immutable/],
      ["/api/game/status", /^no-store$/],
    ];
    for (const [urlPath, expected] of probes) {
      expect(resolveCacheControl(urlPath), `${urlPath} 被前置规则屏蔽了`).toMatch(expected);
    }
  });

  it("API 一律不缓存", () => {
    expect(resolveCacheControl("/api/game/status")).toBe("no-store");
    expect(resolveCacheControl("/api/songuessr/ws")).toBe("no-store");
  });

  it("caches 与 headers 的 TTL 档位一致", () => {
    // 边缘缓存时长必须与下发的 Cache-Control 对齐：只改一处会让浏览器与
    // 边缘对同一资源的保鲜期判断不同，排查时极难定位。
    expect(Array.isArray(config.caches)).toBe(true);
    const caches = config.caches ?? [];
    expect(caches.length).toBeGreaterThan(0);

    for (const entry of caches) {
      const headerValue = resolveCacheControl(entry.source);
      if (!headerValue || headerValue === "no-store") continue;
      const maxAge = /max-age=(\d+)/.exec(headerValue)?.[1];
      if (maxAge === undefined) continue;
      expect(
        entry.cacheTtl,
        `${entry.source} 的 cacheTtl=${entry.cacheTtl} 与 Cache-Control 的 max-age=${maxAge} 不一致`
      ).toBe(Number(maxAge));
    }
  });

  it("不在 caches 里对 HTML 或 API 设置正数 TTL", () => {
    for (const entry of config.caches ?? []) {
      if (entry.source === "/api/*") {
        expect(entry.cacheTtl, "/api/* 必须为 0").toBe(0);
      }
    }
  });
});

/**
 * 托管构建入口的口径守卫（审查 F52）。
 *
 * `Client/edgeone.json` 是边缘响应头与缓存规则的唯一真相源，并且**不**声明安装/构建命令；
 * `Client/esa.jsonc` 是备用平台形态，只承担构建命令口径。两份配置曾经互相矛盾——
 * esa.jsonc 写 `npm install`，而 CI 与依赖权威（根 `pnpm-lock.yaml`）走 pnpm 冻结锁：
 * 托管构建一旦按那份口径跑，线上 bundle 的依赖树就与 CI 获验过的不是同一棵。
 *
 * 这里把「只有一份声明构建入口、且与 CI 逐字一致」固化成断言。
 * 规则来源见 Agents/Conventions.md §4 与 Agents/Deployment.md §8。
 */

/** CI 客户端作业的口径：安装用冻结锁，构建按 workspace 过滤。 */
const CI_INSTALL_COMMAND = "pnpm install --frozen-lockfile";
const CI_BUILD_COMMAND = "pnpm --filter client build";

/** 去掉行注释、块注释与尾逗号：托管配置允许 JSONC 写法（esa.jsonc 就带说明注释）。 */
function parseJsonc(text: string): Record<string, unknown> {
  return JSON.parse(
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\n)[ \t]*\/\/[^\n]*/g, "$1")
      .replace(/,(\s*[}\]])/g, "$1")
  ) as Record<string, unknown>;
}

const clientRoot = path.resolve(__dirname, "../..");
const ciWorkflow = readFileSync(path.resolve(clientRoot, "../.github/workflows/ci.yml"), "utf8");

describe("托管构建入口口径", () => {
  const hostingConfigs = ["edgeone.json", "esa.jsonc"].map((name) => ({
    name,
    config: parseJsonc(readFileSync(path.join(clientRoot, name), "utf8")),
  }));

  it("只有一份托管配置声明构建入口，不存在互相冲突的第二套口径", () => {
    const declaring = hostingConfigs.filter(
      (entry) =>
        entry.config.installCommand !== undefined || entry.config.buildCommand !== undefined
    );
    expect(
      declaring.map((entry) => entry.name),
      "构建入口只能由一份托管配置声明"
    ).toEqual(["esa.jsonc"]);
  });

  it("声明的构建入口与 CI 客户端作业逐字一致", () => {
    const esa = hostingConfigs.find((entry) => entry.name === "esa.jsonc")?.config ?? {};
    expect(esa.installCommand, "安装必须走根级 pnpm-lock.yaml 的冻结锁").toBe(CI_INSTALL_COMMAND);
    expect(esa.buildCommand, "构建必须走 workspace 过滤，与 CI 同一条命令").toBe(CI_BUILD_COMMAND);
  });

  it("CI 侧口径本身没有被改掉（改动 CI 时同步这里的常量）", () => {
    expect(
      ciWorkflow,
      `ci.yml 里找不到 "${CI_INSTALL_COMMAND}"，F52 常量需要跟着 CI 一起改`
    ).toContain(CI_INSTALL_COMMAND);
    expect(
      ciWorkflow,
      `ci.yml 里找不到 "${CI_BUILD_COMMAND}"，F52 常量需要跟着 CI 一起改`
    ).toContain(CI_BUILD_COMMAND);
  });

  it("任何托管配置里都不出现 npm/yarn 口径的安装命令", () => {
    for (const entry of hostingConfigs) {
      for (const key of ["installCommand", "buildCommand"]) {
        const value = entry.config[key];
        if (typeof value !== "string") continue;
        expect(
          value,
          `${entry.name} 的 ${key} 不得使用 npm/yarn 解析依赖（依赖权威是根 pnpm-lock.yaml）`
        ).not.toMatch(/^\s*(npm|yarn)\s+(install|ci|run)\b/);
        if (key === "installCommand")
          expect(value, "安装命令必须带 --frozen-lockfile，否则托管构建会浮动解析").toContain(
            "--frozen-lockfile"
          );
      }
    }
  });
});
