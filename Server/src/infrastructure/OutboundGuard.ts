import { BlockList, isIP } from "node:net";

type OutboundFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const BLOCKED_DOMAIN_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

/**
 * 禁止出站的网段：内网、链路本地（云厂商元数据服务在 169.254）、CGNAT、设备基准测试段、
 * 组播与保留段，以及 NAT64 前缀（可把内网 v4 包进去）。
 * 规则是数据而不是分支；新增保留段只改这张表。注意 `BlockList` 把 IPv4 与 `::ffff:0:0/96`
 * 视为等价，映射地址由它自己还原判定，表里不要再登记映射段。
 */
const BLOCKED_SUBNETS: ReadonlyArray<
  readonly [network: string, prefix: number, family: "ipv4" | "ipv6"]
> = [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 16, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["224.0.0.0", 3, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["64:ff9b::", 32, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
];

const blockedSubnets = new BlockList();
for (const [network, prefix, family] of BLOCKED_SUBNETS) {
  blockedSubnets.addSubnet(network, prefix, family);
}

/** IPv4 / IPv6 字面量是否落在禁止网段；不是 IP 字面量返回 undefined 交给域名规则。 */
const isBlockedIpLiteral = (host: string): boolean | undefined => {
  // 区域标识（`%eth0`）不属于地址本身。
  const plain = host.split("%")[0]!;
  const family = isIP(plain);
  if (family === 0) return undefined;
  return blockedSubnets.check(plain, family === 4 ? "ipv4" : "ipv6");
};

/**
 * 出站目标主机是否禁止访问：字面量内网/保留地址、`localhost` 家族与无点单标签名。
 * 公开 DNS 名解析到内网（含 DNS rebinding）不在本函数能力内——抓取方必须同时禁用自动跳转，
 * 并在每一跳重新判定；真要封死得自己控制解析，见 Deployment 的出网前提。
 */
export const isBlockedOutboundHost = (rawHost: string): boolean => {
  const host = rawHost
    .replace(/^\[|\]$/g, "")
    .trim()
    .toLowerCase();
  if (!host) return true;
  if (host.includes(":")) return isBlockedIpLiteral(host) ?? false;
  // 纯数字与点组成却不是规范点分四段（整数形态、前导零、段数不足）：URL 归一化之后
  // 不该出现，出现就按拒绝处理，不去猜它会被解析成哪个地址。
  if (/^[\d.]+$/.test(host)) return isBlockedIpLiteral(host) ?? true;
  if (host === "localhost" || !host.includes(".")) return true;
  return BLOCKED_DOMAIN_SUFFIXES.some((suffix) => host.endsWith(suffix));
};

/** 校验一个可以代表服务端出站的 http(s) 地址；不合规一律抛错，由调用方映射成业务错误。 */
export const assertOutboundUrl = (raw: string | URL): URL => {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw new Error("出站地址无法解析");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("出站地址只允许 http(s)");
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
  options: { pinOrigin?: boolean; maxRedirects?: number } = {}
): Promise<Response> => {
  const maxRedirects = options.maxRedirects ?? 3;
  let target = options.pinOrigin ? new URL(url) : assertOutboundUrl(url);
  for (let hop = 0; ; hop += 1) {
    const response = await fetcher(target.href, { ...init, redirect: "manual" });
    const location = REDIRECT_STATUSES.has(response.status)
      ? response.headers.get("location")
      : null;
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
    if (options.pinOrigin && next.origin !== target.origin)
      throw new Error("出站跳转离开允许的主机");
    if (!options.pinOrigin) assertOutboundUrl(next);
    if (hop >= maxRedirects) throw new Error("出站跳转次数超限");
    target = next;
  }
};
