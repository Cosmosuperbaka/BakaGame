// ==================== 原生壳的 User-Agent 段 ====================
// 桌面壳与移动壳在请求里带同一种客户端段，格式：
//
//   BakaGame/<客户端版本> (<系统名> <系统版本>; <架构>; <客户端类型>) Game/<游戏版本>
//
// WebView 里追加在默认浏览器 UA 之后（空格分隔），壳内原生请求只发这一段。
// **用于诊断与统计**：UA 由客户端自报、可以随意伪造，不得参与任何信任或准入判定。唯一例外是
// 「伪造只坏了伪造者自己」的兼容性提示（macOS 更新按系统版本避开装不上的新包），见 ClientChannel 文档。
// 本文件是纯值模块（不引入 schema 库）；各壳源码里写死的格式与取值规则（Rust 与 Kotlin）
// 由壳契约对账测试与这里逐项核对，改规则要三处一起改。

/** 段首的产品名 */
export const CLIENT_UA_PRODUCT = "BakaGame";
/** 游戏版本那一截的产品名 */
export const CLIENT_UA_GAME_PRODUCT = "Game";
/** 系统名词表：取值固定，不随系统自报的名字变化 */
export const CLIENT_UA_OS_NAMES = ["Windows", "macOS", "Android"] as const;
export type ClientUaOsName = (typeof CLIENT_UA_OS_NAMES)[number];
/** 客户端类型沿用通道契约的取值 */
export const CLIENT_UA_CLIENT_TYPES = ["desktop", "mobile"] as const;
export type ClientUaClientType = (typeof CLIENT_UA_CLIENT_TYPES)[number];
/** 任何一截取不到时的占位 */
export const CLIENT_UA_UNKNOWN = "unknown";
/** 单截取值的长度上限（去掉非法字符之后截断） */
export const CLIENT_UA_TOKEN_MAX_LENGTH = 32;
/** 短提交号统一成这么长，与页面 `bakagame-build` 元信息的写法一致 */
export const CLIENT_UA_COMMIT_LENGTH = 7;

/** 网页客户端在站点根下发布的版本清单路径（构建期生成，不得被长缓存） */
export const GAME_VERSION_MANIFEST_PATH = "/version.json";

/** 版本清单的内容：这两个字段必须有，可以有其它字段 */
export interface GameVersionManifest {
  /** 产品版本：更新日志里的最大版本，如 `2.0.3` */
  version: string;
  /** 短提交号：7 位小写，与页面 `bakagame-build` 同口径 */
  commit: string;
}

export interface ClientUserAgent {
  /** 壳自己的版本 */
  clientVersion: string;
  osName: ClientUaOsName;
  osVersion: string;
  arch: string;
  clientType: ClientUaClientType;
  /** `<产品版本>+<短提交号>`；取不到时为 `unknown` */
  gameVersion: string;
}

/**
 * 取值规则（三端一致）：单截只留 `[A-Za-z0-9._-]`，括号、分号、空白是 UA 的分隔符，
 * 混进来会把整段切坏；游戏版本另外允许中间一个 `+`。
 */
export const CLIENT_UA_TOKEN_UNSAFE = /[^A-Za-z0-9._-]/g;
export const CLIENT_UA_PRODUCT_VERSION = /^\d+(\.\d+){1,3}([-.][0-9A-Za-z.-]{1,32})?$/;
export const CLIENT_UA_SHORT_COMMIT = /^[0-9a-fA-F]{7,40}$/;
const TOKEN = "[A-Za-z0-9._-]+";

/** 把一截取值收成 UA 里安全的形状：去掉非法字符、截到上限，空了即 `unknown` */
export const clientUaToken = (value: string | null | undefined): string => {
  const cleaned = (value ?? "")
    .trim()
    .replace(CLIENT_UA_TOKEN_UNSAFE, "")
    .slice(0, CLIENT_UA_TOKEN_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : CLIENT_UA_UNKNOWN;
};

/** 游戏版本那一截：恰好是 `<版本>+<提交号>` 两段且都有值才保留，否则 `unknown` */
export const clientUaGameToken = (value: string | null | undefined): string => {
  const text = (value ?? "").trim();
  if (text.length === 0 || text === CLIENT_UA_UNKNOWN) return CLIENT_UA_UNKNOWN;
  const parts = text.split("+");
  if (parts.length !== 2) return CLIENT_UA_UNKNOWN;
  const version = clientUaToken(parts[0]);
  const commit = clientUaToken(parts[1]);
  return version === CLIENT_UA_UNKNOWN || commit === CLIENT_UA_UNKNOWN
    ? CLIENT_UA_UNKNOWN
    : `${version}+${commit}`;
};

/** 游戏版本：`<产品版本>+<短提交号>`，任何一项缺失或格式不对都是 `unknown` */
export const formatGameVersion = (
  version: string | null | undefined,
  commit: string | null | undefined
): string => {
  const product = (version ?? "").trim();
  const short = (commit ?? "").trim();
  if (!CLIENT_UA_PRODUCT_VERSION.test(product) || !CLIENT_UA_SHORT_COMMIT.test(short)) {
    return CLIENT_UA_UNKNOWN;
  }
  return `${product}+${short.toLowerCase().slice(0, CLIENT_UA_COMMIT_LENGTH)}`;
};

/** 读版本清单的 JSON：形状不对一律当取不到 */
export const gameVersionFromManifest = (value: unknown): string => {
  if (!value || typeof value !== "object") return CLIENT_UA_UNKNOWN;
  const record = value as Record<string, unknown>;
  return formatGameVersion(
    typeof record.version === "string" ? record.version : undefined,
    typeof record.commit === "string" ? record.commit : undefined
  );
};

export const formatClientUserAgent = (ua: ClientUserAgent): string =>
  `${CLIENT_UA_PRODUCT}/${clientUaToken(ua.clientVersion)} ` +
  `(${ua.osName} ${clientUaToken(ua.osVersion)}; ${clientUaToken(ua.arch)}; ${ua.clientType}) ` +
  `${CLIENT_UA_GAME_PRODUCT}/${clientUaGameToken(ua.gameVersion)}`;

const SEGMENT = new RegExp(
  `(?:^|\\s)${CLIENT_UA_PRODUCT}/(${TOKEN}) \\((${CLIENT_UA_OS_NAMES.join("|")}) (${TOKEN}); ` +
    `(${TOKEN}); (${CLIENT_UA_CLIENT_TYPES.join("|")})\\) ${CLIENT_UA_GAME_PRODUCT}/(${TOKEN}(?:\\+${TOKEN})?)(?=\\s|$)`
);

/** 从完整 UA（WebView 默认串加客户端段，或原生请求只有这一段）里取出客户端段；没有就是网页 */
export const parseClientUserAgent = (header: string | null | undefined): ClientUserAgent | null => {
  const match = SEGMENT.exec(header ?? "");
  if (!match) return null;
  return {
    clientVersion: match[1],
    osName: match[2] as ClientUaOsName,
    osVersion: match[3],
    arch: match[4],
    clientType: match[5] as ClientUaClientType,
    gameVersion: match[6],
  };
};
