/**
 * 客户端安装包的制品元数据：首页下载弹窗与更新提醒要显示「版本 / 构建日期 / 文件大小 / 架构」，
 * 这些值只有对象存储那头知道，所以在服务端对公开别名发一次 HEAD、再读一次同名的
 * `.version` 旁文件。
 *
 * 版本旁文件是发布流水线写的纯文本（例如 `BakaGame-latest-x64.exe.version` 内容为 `0.1.1`）：
 * 固定别名本身不带版本号，服务端不可能从文件名反推；没有它，「已发布最新版比玩家旧」
 * 这条软提醒就永远没有依据。旁文件缺失时只少一档提醒，不影响下载与硬门槛。
 *
 * 探测失败（404 = 制品还没推上去、超时、边缘节点抽风）一律归成「读不到元数据」而不是报错：
 * 这条只是给页面贴标签用的，不该拦住首页，也不该让弹窗开不起来。
 */

export type ClientPackagePlatform = "windows" | "android";

export interface ClientPackage {
  platform: ClientPackagePlatform;
  /** 安装包架构：发布约定的固定事实，不靠探测（NSIS 只出 x64；APK 不按 ABI 拆分）。 */
  arch: string;
  /** 玩家点开的地址，与探测用的是同一条链接：读到什么就发什么，不存在两份口径。 */
  url: string;
  /** 发布流水线写下的壳版本；旁文件缺失或格式不对时为空。 */
  version?: string;
  /** 下面两个字段只在制品确实存在时给出。 */
  sizeBytes?: number;
  /** 对象的最后修改时间（ISO 串）：CI 推包即更新，比任何手写日期都跟版。 */
  builtAt?: string;
  /** 制品到底在不在：弹窗据此把下载按钮置灰，而不是让玩家点到 404。 */
  available: boolean;
}

/** 元数据只在发版时变，读一次顶住这一分钟内所有首页打开，顺便盖住 404 的重试。 */
export const CLIENT_PACKAGE_TTL_MS = 60_000;

/**
 * 单次探测上限。`/api/client/update-check` 现在要顺带问「最新发布版」，
 * 不能因为 CDN 卡住就把首页提醒一起拖住——读不到就当作没有这一档依据。
 */
const PROBE_TIMEOUT_MS = 3_000;

const ARCH_BY_PLATFORM: Record<ClientPackagePlatform, string> = {
  windows: "x64",
  android: "全架构通用",
};

/** 列表顺序即弹窗里的顺序：Windows 在前。 */
const PLATFORMS: ClientPackagePlatform[] = ["windows", "android"];

export interface ClientArtifactsOptions {
  /** 平台 → 公开下载地址；没配或配成空串的平台不进列表。 */
  urls: Partial<Record<ClientPackagePlatform, string | undefined>>;
  fetcher?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}

interface Probe {
  available: boolean;
  version?: string;
  sizeBytes?: number;
  builtAt?: string;
}

/** 与壳自报、服务端校验的版本形状保持一致：只认点分数字。 */
const VERSION_PATTERN = /^\d+(\.\d+){0,3}$/;

export class ClientArtifacts {
  private readonly urls: Partial<Record<ClientPackagePlatform, string | undefined>>;
  private readonly fetcher: typeof fetch;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** 存的是在途 promise：同一分钟内并发进来也只发一次 HEAD。 */
  private readonly probes = new Map<
    ClientPackagePlatform,
    { expiresAt: number; promise: Promise<Probe> }
  >();

  constructor(options: ClientArtifactsOptions) {
    this.urls = options.urls;
    this.fetcher = options.fetcher ?? fetch;
    this.ttlMs = options.ttlMs ?? CLIENT_PACKAGE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async list(): Promise<ClientPackage[]> {
    const pending = PLATFORMS.flatMap((platform) => {
      const url = this.urls[platform]?.trim();
      if (!url) return [];
      return [
        this.probe(platform, url).then((probe): ClientPackage => ({
          platform,
          arch: ARCH_BY_PLATFORM[platform],
          url,
          ...(probe.version ? { version: probe.version } : {}),
          available: probe.available,
          sizeBytes: probe.sizeBytes,
          builtAt: probe.builtAt,
        })),
      ];
    });
    return Promise.all(pending);
  }

  /** 该平台已发布的最新壳版本：旁文件读不到就是 `undefined`，调用方按「没有软提醒依据」处理。 */
  async latestVersion(platform: ClientPackagePlatform): Promise<string | undefined> {
    const url = this.urls[platform]?.trim();
    if (!url) return undefined;
    return (await this.probe(platform, url)).version;
  }

  private probe(platform: ClientPackagePlatform, url: string): Promise<Probe> {
    const at = this.now();
    const cached = this.probes.get(platform);
    if (cached && cached.expiresAt > at) return cached.promise;
    // HEAD 与版本旁文件一起打：两者都只读元数据、共用同一个 TTL，
    // 分两次发会在「刚好跨过发版」时给出自相矛盾的一组值。
    const promise = Promise.all([this.head(url), this.versionOf(url)]).then(
      ([head, version]): Probe => ({ ...head, version })
    );
    this.probes.set(platform, { expiresAt: at + this.ttlMs, promise });
    return promise;
  }

  private async head(url: string): Promise<Probe> {
    try {
      const response = await this.fetcher(url, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) return { available: false };
      return {
        available: true,
        sizeBytes: sizeOf(response.headers),
        builtAt: lastModified(response.headers),
      };
    } catch {
      return { available: false };
    }
  }

  /** 旁文件是流水线写的纯文本；读不到、解析失败、格式不对都只当「没有版本」，不抛错。 */
  private async versionOf(url: string): Promise<string | undefined> {
    try {
      // 用 URL 改 pathname，保留可能存在的查询串；直接拼 `${url}.version` 会在带查询时拼错。
      const versionUrl = new URL(url);
      versionUrl.pathname = `${versionUrl.pathname}.version`;
      const response = await this.fetcher(versionUrl.toString(), {
        redirect: "follow",
        headers: { Accept: "text/plain" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const value = (await response.text()).trim();
      return VERSION_PATTERN.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

/** 非 2xx 的响应也带 content-length（那是错误正文的长度），所以只在 2xx 分支里调这一句。 */
const sizeOf = (headers: Headers): number | undefined => {
  const raw = Number(headers.get("content-length"));
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
};

const lastModified = (headers: Headers): string | undefined => {
  const value = headers.get("last-modified");
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};
