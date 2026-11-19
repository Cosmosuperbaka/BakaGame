import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export type ChinaIpRange = { start: number; end: number; count: number };

// 中国 IP 段真相源复用 Enhanced API 包内 `data/china_ip_ranges.txt`（4147 条 CIDR）。
// 早前自写的 `116.25-94.x.x` 随机拼接并不保证落在真实 CN 网段，网易云按出口 IP
// 绑定登录态时会因此判定为异地登录，是「设备还在但凭证失效」的根因之一。
// 这里刻意绕开包内 `util/index.js`，因为它会在模块加载时连带引入其 `logger`，
// 每次生成都会向 stdout 打印带 ANSI 色的 [INFO] 行，污染本项目的结构化日志。
const CHINA_IP_CIDR_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

// CN IP 段数据来自依赖包。**不能写死 `../../node_modules/...`**：本仓库是 pnpm
// workspace，依赖会提升到仓库根（`<root>/node_modules`），Server 下并不存在
// `Server/node_modules`，写死路径会让 parseChinaIpRanges 静默拿到空串，
// 随机出口 IP 退化成兜底单段。这里走 Node 的模块解析，两种安装布局都能命中
// （独立安装时命中 Server/node_modules，workspace 提升时命中根 node_modules）。
const requireFromHere = createRequire(import.meta.url);
const chinaIpRangeFile = (): string => {
  const packageFile = requireFromHere.resolve("@neteasecloudmusicapienhanced/api/package.json");
  return resolve(dirname(packageFile), "data/china_ip_ranges.txt");
};

export const parseChinaIpRanges = (content: string): ChinaIpRange[] => {
  const ranges: ChinaIpRange[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const matched = CHINA_IP_CIDR_PATTERN.exec(line);
    if (!matched) continue;
    const octets = matched.slice(1, 5).map(Number);
    if (octets.some((octet) => octet > 255)) continue;
    const prefix = Number(matched[5]);
    if (prefix > 32) continue;
    const base = octets.reduce((acc, octet) => (acc << 8) + octet, 0) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const start = (base & mask) >>> 0;
    const end = (start | (~mask >>> 0)) >>> 0;
    ranges.push({ start, end, count: end - start + 1 });
  }
  return ranges;
};

const intToIp = (value: number): string =>
  [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");

export const readChinaIpRanges = (): ChinaIpRange[] => {
  try {
    const path = chinaIpRangeFile();
    return existsSync(path) ? parseChinaIpRanges(readFileSync(path, "utf8")) : [];
  } catch {
    return [];
  }
};

// 兜底：仅在 CN IP 段数据缺失/损坏时生效，保证不至于完全无法出网。
const FALLBACK_CHINA_IP_RANGES: ChinaIpRange[] = [
  { start: 0x74000000, end: 0x74ffffff, count: 0x1000000 }, // 116.0.0.0/8
];

// 生成落在真实 CN 网段内的随机 IP；random 可注入以便确定性测试。
export const randomChineseIp = (
  ranges: readonly ChinaIpRange[],
  random?: { nextFloat?: () => number }
): string => {
  const rand = random?.nextFloat ?? Math.random;
  const usable = ranges.length > 0 ? ranges : FALLBACK_CHINA_IP_RANGES;
  const total = usable.reduce((sum, range) => sum + range.count, 0);
  let offset = Math.floor(rand() * total);
  let chosen = usable[usable.length - 1];
  for (const range of usable) {
    if (offset < range.count) {
      chosen = range;
      break;
    }
    offset -= range.count;
  }
  return intToIp((chosen.start + Math.floor(rand() * chosen.count)) >>> 0);
};
