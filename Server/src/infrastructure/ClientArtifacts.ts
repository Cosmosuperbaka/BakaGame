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
 *
 * 桌面壳的自动更新也从这里取数：更新器要的「版本 + 地址 + 签名」分别来自 `.version` 旁文件、
 * 更新包地址本身与 `.sig` 签名旁文件（发布流水线用更新签名私钥生成）。服务端只读这几个小文件，
 * 安装包字节永远由对象存储直接发给壳，源站不转发。
 */

export type ClientPackagePlatform = "windows" | "macos" | "android";

export interface ClientPackage {
  platform: ClientPackagePlatform;
  /**
   * 安装包架构：发布约定的固定事实，不靠探测（NSIS 只出 x64；macOS 出 Apple 芯片与 Intel
   * 合一的通用包；APK 不按 ABI 拆分）。
   */
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
  macos: "Intel 与 Apple 芯片",
  android: "全架构通用",
};

/** 列表顺序即弹窗里的顺序：两个桌面平台在前，Windows 打头。 */
const PLATFORMS: ClientPackagePlatform[] = ["windows", "macos", "android"];

/**
 * 桌面壳自动更新的平台。Windows 的更新包就是 NSIS 安装包本身；macOS 的更新包是 `.app.tar.gz`，
 * 与下载弹窗给的 dmg 不是同一个文件，所以单独配地址。
 */
export type UpdaterPlatform = "windows" | "macos";

/** 一个可供壳自动更新的发布：三样都齐了才算，缺一样就当没有新版。 */
export interface UpdaterRelease {
  version: string;
  /** 对象存储/CDN 上的更新包地址：壳直接从这里下载，源站只给地址。 */
  url: string;
  /** `.sig` 旁文件的原文（minisign 签名的 base64），壳用编进二进制的公钥校验。 */
  signature: string;
  /** 更新包对象的最后修改时间（ISO 串）；读不到时省略。 */
  pubDate?: string;
}

export interface ClientArtifactsOptions {
  /** 平台 → 公开下载地址；没配或配成空串的平台不进列表。 */
  urls: Partial<Record<ClientPackagePlatform, string | undefined>>;
  /** 平台 → 自动更新包地址；没配或配成空串的平台没有自动更新。 */
  updaterUrls?: Partial<Record<UpdaterPlatform, string | undefined>>;
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

/** minisign 签名的 base64 原文只有几百字节；超长或混进别的字符都当读不到，不交给壳。 */
const SIGNATURE_MAX_LENGTH = 4_096;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

interface Cached<T> {
  expiresAt: number;
  promise: Promise<T>;
}

export class ClientArtifacts {
  private readonly urls: Partial<Record<ClientPackagePlatform, string | undefined>>;
  private readonly updaterUrls: Partial<Record<UpdaterPlatform, string | undefined>>;
  private readonly fetcher: typeof fetch;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /**
   * 存的是在途 promise：同一分钟内并发进来也只发一次 HEAD。按地址缓存：Windows 的更新包与
   * 下载用的安装包是同一个对象，下载弹窗与更新器共用一次探测。
   */
  private readonly probes = new Map<string, Cached<Probe>>();
  private readonly signatures = new Map<string, Cached<string | undefined>>();

  constructor(options: ClientArtifactsOptions) {
    this.urls = options.urls;
    this.updaterUrls = options.updaterUrls ?? {};
    this.fetcher = options.fetcher ?? fetch;
    this.ttlMs = options.ttlMs ?? CLIENT_PACKAGE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async list(): Promise<ClientPackage[]> {
    const pending = PLATFORMS.flatMap((platform) => {
      const url = this.urls[platform]?.trim();
      if (!url) return [];
      return [
        this.probe(url).then((probe): ClientPackage => ({
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
    return (await this.probe(url)).version;
  }

  /**
   * 该平台可供自动更新的最新发布：更新包在、版本旁文件与签名旁文件都读得到才返回。
   * 发布顺序是先传更新包与签名、最后写版本旁文件，所以版本一变，同批的签名已经就位；
   * 万一读到新包配旧签名，壳校验失败只会稍后重试，不会装错。
   */
  async updaterRelease(platform: UpdaterPlatform): Promise<UpdaterRelease | undefined> {
    const url = this.updaterUrls[platform]?.trim();
    if (!url) return undefined;
    const [probe, signature] = await Promise.all([this.probe(url), this.signature(url)]);
    if (!probe.available || !probe.version || !signature) return undefined;
    return {
      version: probe.version,
      url,
      signature,
      ...(probe.builtAt ? { pubDate: probe.builtAt } : {}),
    };
  }

  private probe(url: string): Promise<Probe> {
    return this.cached(this.probes, url, () =>
      // HEAD 与版本旁文件一起打：两者都只读元数据、共用同一个 TTL，
      // 分两次发会在「刚好跨过发版」时给出自相矛盾的一组值。
      Promise.all([this.head(url), this.versionOf(url)]).then(([head, version]): Probe => ({
        ...head,
        version,
      }))
    );
  }

  private signature(url: string): Promise<string | undefined> {
    return this.cached(this.signatures, url, () => this.signatureOf(url));
  }

  private cached<T>(cache: Map<string, Cached<T>>, key: string, load: () => Promise<T>) {
    const at = this.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > at) return hit.promise;
    const promise = load();
    cache.set(key, { expiresAt: at + this.ttlMs, promise });
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
    const value = await this.sidecar(url, ".version");
    return value !== undefined && VERSION_PATTERN.test(value) ? value : undefined;
  }

  /** 签名旁文件同样只当元数据读：读不到或形状不对就当没有签名，这一档不给壳更新。 */
  private async signatureOf(url: string): Promise<string | undefined> {
    const value = await this.sidecar(url, ".sig");
    if (value === undefined || value.length > SIGNATURE_MAX_LENGTH) return undefined;
    return SIGNATURE_PATTERN.test(value) ? value : undefined;
  }

  /** 读 `<地址><后缀>` 的纯文本并去掉首尾空白；任何失败都返回 `undefined`。 */
  private async sidecar(url: string, suffix: string): Promise<string | undefined> {
    try {
      // 用 URL 改 pathname，保留可能存在的查询串；直接拼 `${url}.version` 会在带查询时拼错。
      const sidecarUrl = new URL(url);
      sidecarUrl.pathname = `${sidecarUrl.pathname}${suffix}`;
      const response = await this.fetcher(sidecarUrl.toString(), {
        redirect: "follow",
        headers: { Accept: "text/plain" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      return (await response.text()).trim();
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
