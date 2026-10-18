type OutboundFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const BLOCKED_DOMAIN_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

/** 点分四段（或已被 URL 解析器归一化的等价写法）是否落在内网、链路本地与保留网段。 */
const isBlockedIpv4 = (host: string): boolean => {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地：云厂商元数据服务在这里
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // 设备基准测试网段
  return a >= 224; // 组播与保留段
};

const isBlockedIpv6 = (host: string): boolean => {
  const plain = host.replace(/^\[|\]$/g, "").split("%")[0]!;
  // `::ffff:7f00:1`：URL 解析器会把 IPv4 映射地址里的十进制段转成十六进制，得还原后再判定。
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(plain);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16);
    const low = Number.parseInt(mappedHex[2]!, 16);
    return isBlockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const mappedDotted = /^::ffff:(.+)$/i.exec(plain)?.[1];
  if (mappedDotted?.includes(".")) return isBlockedIpv4(mappedDotted);
  if (plain === "::" || plain === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(plain)) return true; // ULA fc00::/7
  if (/^fe[89ab]/i.test(plain)) return true; // 链路本地 fe80::/10
  if (/^ff[0-9a-f]{2}:/i.test(plain)) return true; // 组播
  return /^64:ff9b:/i.test(plain); // NAT64 前缀可以把内网 v4 包进去
};

/**
 * 出站目标主机是否禁止访问：字面量内网/保留地址、`localhost` 家族与无点单标签名。
 * 公开 DNS 名解析到内网（含 DNS rebinding）不在本函数能力内——抓取方必须同时禁用自动跳转，
 * 并在每一跳重新判定；真要封死得自己控制解析，见 Deployment 的出网前提。
 */
export const isBlockedOutboundHost = (rawHost: string): boolean => {
  const host = rawHost.replace(/^\[|\]$/g, "").trim().toLowerCase();
  if (!host) return true;
  if (host.includes(":")) return isBlockedIpv6(host);
  if (/^\d+$/.test(host)) return true; // 十进制整数形态的 IPv4 不该出现在归一化之后的 URL 里
  if (isBlockedIpv4(host)) return true;
  if (host === "localhost" || !host.includes(".")) return true;
  return BLOCKED_DOMAIN_SUFFIXES.some(suffix => host.endsWith(suffix));
};

/** 校验一个可以代表服务端出站的 http(s) 地址；不合规一律抛错，由调用方映射成业务错误。 */
export const assertOutboundUrl = (raw: string | URL): URL => {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw new Error("出站地址无法解析");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("出站地址只允许 http(s)");
  if (url.username || url.password) throw new Error("出站地址不得携带凭据");
  if (isBlockedOutboundHost(url.hostname)) throw new Error("出站地址不允许指向内网或保留主机");
  return url;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 带护栏的出站抓取：永不交给运行时自动跟随跳转，而是逐跳复核目标地址。
 * - 默认每跳都跑 `assertOutboundUrl`（第三方数据里的图片地址属于不可信输入）；
 * - `pinOrigin` 用于基址本身可信、只想禁止被上游带离本站的场合（自建图床、qlogo）。
 */
export const fetchWithGuardedRedirects = async (
  fetcher: OutboundFetcher,
  url: string | URL,
  init: RequestInit = {},
  options: { pinOrigin?: boolean; maxRedirects?: number } = {},
): Promise<Response> => {
  const maxRedirects = options.maxRedirects ?? 3;
  let target = options.pinOrigin ? new URL(url) : assertOutboundUrl(url);
  for (let hop = 0; ; hop += 1) {
    const response = await fetcher(target.href, { ...init, redirect: "manual" });
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (!location) return response;
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      await response.body?.cancel().catch(() => {});
      throw new Error("出站跳转地址无法解析");
    }
    // 跳转响应体一律先释放，否则失败路径会把连接挂在途上。
    await response.body?.cancel().catch(() => {});
    if (options.pinOrigin && next.origin !== target.origin) throw new Error("出站跳转离开允许的主机");
    if (!options.pinOrigin) assertOutboundUrl(next);
    if (hop >= maxRedirects) throw new Error("出站跳转次数超限");
    target = next;
  }
};
