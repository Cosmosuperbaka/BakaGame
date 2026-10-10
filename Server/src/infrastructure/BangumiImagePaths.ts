/**
 * 图床缓存路径的唯一映射规则：上游原始 URL → 缓存里的路径。
 *
 * 这张表必须与 `tools/build_bangumi_images.py` 的 `to_path` / `resize_path` /
 * `image_targets` **严格一致** —— 不一致的后果是「缓存明明有、运行时却当缺失」
 * 或者反过来反复重下同一张图。
 *
 * 档位（用户定规格，2026-10-09）：
 * - 作品封面一律 `/r/200/`（最长显示 80×112 的 2x），缓存里只有这一档；
 * - 角色大图 `/r/400/`（最长显示 96×128 的 2x）；
 * - 角色方格图用 `grid` 原路径（列表 36~40px 方形）。
 *
 * 判定按 **URL 形状** 而不是调用方声明的用途：网格请求回退到大图时（角色没有
 * `grid`），同一份大图 URL 依然映射到 `/r/400/`，照样命中缓存。未知形状返回
 * `null`，调用方保留旧的「只换 host」行为——宁可让缓存少命中一次，也不改坏 URL。
 */

/** 去掉主机名，保留路径与查询串（与 python `to_path` 的字符串切割等价）。 */
function stripHost(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.hostname !== "lain.bgm.tv") return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/** 剥掉已有的 `/r/<数字>/` 前缀（与 python `resize_path` 的剥离逻辑一致）。 */
function stripResize(pathname: string): string {
  const parts = pathname.split("/");
  if (parts.length > 3 && parts[1] === "r" && /^\d+$/.test(parts[2])) return `/${parts.slice(3).join("/")}`;
  return pathname;
}

/** 上游原始 URL → 缓存路径；非 lain 主机或未知形状返回 `null`。 */
export function bangumiImageCachePath(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname !== "lain.bgm.tv") return null;
  const pathname = url.pathname;
  const suffix = `${url.search}${url.hash}`;
  // grid 不做任何加工（它不接受缩放档）；其余先剥掉可能已有的 `/r/xxx/` 再套目标档。
  if (pathname.startsWith("/pic/crt/g/")) return `${pathname}${suffix}`;
  const normalized = stripResize(pathname);
  if (normalized.startsWith("/pic/crt/l/")) return `/r/400${normalized}${suffix}`;
  if (normalized.startsWith("/pic/cover/l/")) return `/r/200${normalized}${suffix}`;
  return null;
}

/**
 * 拼出对外的图片 URL：镜像前缀 + 缓存路径；映射不了就退回「只换 host」，与历史行为一致。
 * `value` 非字符串或为空时返回 `undefined`。
 */
export function bangumiImageUrl(value: unknown, base: string): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const rest = stripHost(value);
  if (rest === null) return value;
  if (!base) return value;
  const prefix = base.replace(/\/+$/, "");
  const mapped = bangumiImageCachePath(value);
  return `${prefix}${mapped ?? rest}`;
}
