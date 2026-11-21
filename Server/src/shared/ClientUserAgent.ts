// ==================== 原生壳的 User-Agent 段 ====================
// 桌面壳与移动壳在请求里带同一种客户端段，格式：
//
//   BakaGame/<客户端版本> (<系统名> <系统版本>; <架构>; <客户端类型>) Game/<游戏版本>
//
// WebView 里追加在默认浏览器 UA 之后（空格分隔），壳内原生请求只发这一段。
// **只用于诊断与统计**：UA 由客户端自报、可以随意伪造，不得参与任何信任、准入或判定逻辑。
// 本文件是纯值模块（不引入 schema 库），客户端经 `@bakagame/shared/values` 使用；
// 各壳源码里写死的格式由壳契约对账测试与这里核对。

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

/** 网页客户端在站点根下发布的版本清单路径（构建期生成，不得被长缓存） */
export const GAME_VERSION_MANIFEST_PATH = "/version.json";

/** 版本清单的内容：产品版本（更新日志里的最大版本）与短提交号 */
export interface GameVersionManifest {
  version: string;
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

/** 单截取值允许的字符：括号、分号与空白会打乱段结构，一律去掉 */
const TOKEN_CHARS = /[^A-Za-z0-9._+-]/g;
const TOKEN = "[A-Za-z0-9._+-]+";
const PRODUCT_VERSION = /^\d+(\.\d+){0,3}$/;
const SHORT_COMMIT = /^[0-9a-f]{7,40}$/;

/** 把一截取值收成 UA 里安全的形状；去掉非法字符后为空即 `unknown` */
export const clientUaToken = (value: string | null | undefined): string => {
  const cleaned = (value ?? "").replace(TOKEN_CHARS, "");
  return cleaned.length > 0 ? cleaned : CLIENT_UA_UNKNOWN;
};

/**
 * 游戏版本：`<产品版本>+<短提交号>`。产品版本取不到为 `unknown`；
 * 提交号取不到（非 git 构建给的占位）时只写产品版本。
 */
export const formatGameVersion = (
  version: string | null | undefined,
  commit: string | null | undefined
): string => {
  const product = (version ?? "").trim();
  if (!PRODUCT_VERSION.test(product)) return CLIENT_UA_UNKNOWN;
  const short = (commit ?? "").trim().toLowerCase();
  return SHORT_COMMIT.test(short) ? `${product}+${short}` : product;
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
  `${CLIENT_UA_GAME_PRODUCT}/${clientUaToken(ua.gameVersion)}`;

const SEGMENT = new RegExp(
  `(?:^|\\s)${CLIENT_UA_PRODUCT}/(${TOKEN}) \\((${CLIENT_UA_OS_NAMES.join("|")}) (${TOKEN}); ` +
    `(${TOKEN}); (${CLIENT_UA_CLIENT_TYPES.join("|")})\\) ${CLIENT_UA_GAME_PRODUCT}/(${TOKEN})(?=\\s|$)`
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
