/**
 * 移动壳的 Web 资源热更新清单：发布流水线把 `dist-web` 打成 zip，并在同一个目录写一份
 * `BakaGame-web-latest.json`。壳按清单比较构建标记，决定要不要下载新资源。
 *
 * 清单里的地址只写**文件名**，下载地址由服务端相对清单地址解析：发布基址只有清单地址这一处
 * 配置，换 CDN 时不必同时改两份。文件名必须是裸名（不带路径与 `..`），否则一个被篡改的
 * 清单就能把下载引到别的主机。
 *
 * 读不到清单、清单格式不对、超时都只回「没有可用更新」：热更新是增强，不该让页面加载失败。
 */

/** 清单随发版变化；30 秒足够挡住壳启动时的并发，又不会让新包等太久。 */
export const CLIENT_WEB_BUNDLE_TTL_MS = 30_000;

/** 构建标记只用于比较与展示，但仍拒绝 `..`：它会参与壳内资源目录名。 */
const BUILD_PATTERN = /^(?!.*\.\.)(?!\.$)[A-Za-z0-9._-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const VERSION_PATTERN = /^\d+(\.\d+){0,3}$/;
const ZIP_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}\.zip$/;
/** 清单读取上限：读不到就当没有更新，绝不能拖住壳的启动检查。 */
const MANIFEST_TIMEOUT_MS = 3_000;

export interface ClientWebBundleManifest {
  /** 资源包的构建标记，与 `index.html` 的 `bakagame-build` 同源。 */
  build: string;
  /** 展示用版本号（更新日志里的最大版本），可选。 */
  version?: string;
  /** 资源包文件名；下载地址按清单所在目录解析。 */
  file: string;
  sha256: string;
  sizeBytes?: number;
  /** 能消费这个包的最低壳版本：低于它的壳不下载，避免新资源调用旧壳没有的能力。 */
  minShellVersion?: string;
  publishedAt?: string;
}

export interface ClientWebBundleView extends ClientWebBundleManifest {
  /** 解析后的绝对下载地址（https）。 */
  url: string;
}

export interface ClientWebBundleOptions {
  /** 清单地址；未配置或空串时没有热更新。 */
  manifestUrl?: string;
  fetcher?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}

interface Cached {
  expiresAt: number;
  promise: Promise<ClientWebBundleView | undefined>;
}

export class ClientWebBundle {
  private readonly manifestUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cached?: Cached;

  constructor(options: ClientWebBundleOptions) {
    this.manifestUrl = options.manifestUrl?.trim() ?? "";
    this.fetcher = options.fetcher ?? fetch;
    this.ttlMs = options.ttlMs ?? CLIENT_WEB_BUNDLE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** 当前发布的资源包；没有清单或清单不可用时返回 `undefined`。 */
  async current(): Promise<ClientWebBundleView | undefined> {
    if (!this.manifestUrl) return undefined;
    const at = this.now();
    if (this.cached && this.cached.expiresAt > at) return this.cached.promise;
    // 失败也进缓存：清单服务挂掉时，壳每次启动都来撞一次没有意义。
    const promise = this.fetchManifest();
    this.cached = { expiresAt: at + this.ttlMs, promise };
    return promise;
  }

  private async fetchManifest(): Promise<ClientWebBundleView | undefined> {
    try {
      const response = await this.fetcher(this.manifestUrl, {
        redirect: "follow",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      return parseManifest(await response.json(), this.manifestUrl);
    } catch {
      return undefined;
    }
  }
}

/**
 * 只接受清单约定内的形状。返回 `undefined` 而不是抛错：清单是发布侧产物，
 * 一份写坏的清单应当表现为「没有更新」，而不是让所有壳的启动检查报 500。
 */
export function parseManifest(body: unknown, manifestUrl: string): ClientWebBundleView | undefined {
  if (!body || typeof body !== "object") return undefined;
  const item = body as Record<string, unknown>;
  const build = typeof item.build === "string" ? item.build.trim() : "";
  const file = typeof item.file === "string" ? item.file.trim() : "";
  const sha256 = typeof item.sha256 === "string" ? item.sha256.trim() : "";
  if (!BUILD_PATTERN.test(build)) return undefined;
  if (!ZIP_NAME_PATTERN.test(file) || file.includes("..")) return undefined;
  if (!SHA256_PATTERN.test(sha256)) return undefined;

  let url: URL;
  try {
    url = new URL(file, manifestUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;

  // 可选字段「存在就必须合法」：尤其 minShellVersion，写坏了不能被悄悄当成没有门槛。
  const version = optionalString(item.version, VERSION_PATTERN);
  const minShellVersion = optionalString(item.minShellVersion, VERSION_PATTERN);
  const publishedAt = optionalString(item.publishedAt, /^\d{4}-\d{2}-\d{2}T/);
  const sizeBytes = optionalPositiveInt(item.sizeBytes);
  if (
    version === INVALID ||
    minShellVersion === INVALID ||
    publishedAt === INVALID ||
    sizeBytes === INVALID
  ) {
    return undefined;
  }

  return {
    build,
    ...(version ? { version } : {}),
    file,
    sha256: sha256.toLowerCase(),
    ...(sizeBytes ? { sizeBytes } : {}),
    ...(minShellVersion ? { minShellVersion } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    url: url.toString(),
  };
}

const INVALID = Symbol("invalid");

const optionalString = (value: unknown, pattern: RegExp): string | undefined | typeof INVALID => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return INVALID;
  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : INVALID;
};

const optionalPositiveInt = (value: unknown): number | undefined | typeof INVALID => {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : INVALID;
};
