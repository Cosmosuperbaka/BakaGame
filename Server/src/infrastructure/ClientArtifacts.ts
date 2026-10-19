/**
 * 客户端安装包的制品元数据：首页下载弹窗与更新提醒要显示「构建日期 / 文件大小 / 架构」，
 * 这三个值只有对象存储那头知道，所以在服务端对公开别名发一次 HEAD 读回来。
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
  /** 下面两个字段只在制品确实存在时给出。 */
  sizeBytes?: number;
  /** 对象的最后修改时间（ISO 串）：CI 推包即更新，比任何手写日期都跟版。 */
  builtAt?: string;
  /** 制品到底在不在：弹窗据此把下载按钮置灰，而不是让玩家点到 404。 */
  available: boolean;
}

/** 元数据只在发版时变，读一次顶住这一分钟内所有首页打开，顺便盖住 404 的重试。 */
export const CLIENT_PACKAGE_TTL_MS = 60_000;

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
  sizeBytes?: number;
  builtAt?: string;
}

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
          available: probe.available,
          sizeBytes: probe.sizeBytes,
          builtAt: probe.builtAt,
        })),
      ];
    });
    return Promise.all(pending);
  }

  private probe(platform: ClientPackagePlatform, url: string): Promise<Probe> {
    const at = this.now();
    const cached = this.probes.get(platform);
    if (cached && cached.expiresAt > at) return cached.promise;
    const promise = this.head(url);
    this.probes.set(platform, { expiresAt: at + this.ttlMs, promise });
    return promise;
  }

  private async head(url: string): Promise<Probe> {
    try {
      const response = await this.fetcher(url, { method: "HEAD", redirect: "follow" });
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
