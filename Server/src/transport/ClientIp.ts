import { isIP } from "node:net";

/**
 * ESA 托管转换写入的回源请求头：真实客户端 IP。
 *
 * 该标头由边缘节点在回源时添加，记录与节点建立 TCP 连接的客户端地址；
 * 客户端的 `X-Forwarded-For` 可任意伪造，而这个标头来自链路本身，因此是
 * 唯一可用的来源身份。标头名在 ESA 控制台可改（`RealClientIpHeaderName`），
 * 改名时必须同步这里，否则会静默退回 socket peer（ESA 节点的地址）。
 */
export const REAL_CLIENT_IP_HEADER = "x-real-ip";
/** 改用自定义名称前的默认标头，保留一个发布窗口的兜底。 */
export const LEGACY_REAL_CLIENT_IP_HEADER = "ali-real-client-ip";

const isIpLiteral = (value: string): boolean => isIP(value) === 4 || isIP(value) === 6;

/**
 * 解析请求的来源 IP。
 *
 * 只采信能被解析成 IP 字面量的可信标头，其余情况退回 socket peer：
 * 标头值是限流桶的键，放行任意字符串会让桶随请求无限增长，
 * 也会让客户端用随机值给自己发新桶。按顺序尝试，先命中的胜出。
 */
export const resolveClientIp = (headers: Headers, peerAddress?: string | null): string => {
  for (const name of [REAL_CLIENT_IP_HEADER, LEGACY_REAL_CLIENT_IP_HEADER]) {
    const value = headers.get(name)?.trim();
    if (value && isIpLiteral(value)) return value;
  }
  return peerAddress ?? "unknown";
};
