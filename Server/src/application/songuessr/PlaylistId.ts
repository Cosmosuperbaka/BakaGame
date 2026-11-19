import { AppError } from "../../domain/Errors";

/** 从网易云或 QQ 音乐的歌单链接、分享文本或纯数字里取出歌单 ID。 */
export const parsePlaylistId = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new AppError("INVALID_PLAYLIST", "请输入歌单链接或数字 ID");
  if (trimmed.startsWith("qq:") && /^\d+$/.test(trimmed.slice(3))) return trimmed;
  if (trimmed.startsWith("netease:") && /^\d+$/.test(trimmed.slice(8))) return trimmed;
  if (/^\d+$/.test(trimmed)) return trimmed;

  const parseFromUrl = (url: URL): string | undefined => {
    // 1. QQ 音乐歌单
    if (/y\.qq\.com/i.test(url.hostname)) {
      const id = url.searchParams.get("id") || url.searchParams.get("dissid");
      if (id && /^\d+$/.test(id)) return `qq:${id}`;
      const pathMatch = url.pathname.match(/\/(?:playlist|taoge)\/(\d+)/i);
      if (pathMatch?.[1]) return `qq:${pathMatch[1]}`;
    }

    // 2. 网易云歌单
    const queryId = url.searchParams.get("id");
    if (queryId && /^\d+$/.test(queryId)) return queryId;

    if (url.hash.includes("?")) {
      const hashQuery = url.hash.slice(url.hash.indexOf("?") + 1);
      const hashParams = new URLSearchParams(hashQuery);
      const hashId = hashParams.get("id");
      if (hashId && /^\d+$/.test(hashId)) return hashId;
    }

    const pathMatch = url.pathname.match(/\/playlist\/(\d+)/i);
    if (pathMatch?.[1]) return pathMatch[1];
    return undefined;
  };

  try {
    const url = new URL(trimmed);
    const parsed = parseFromUrl(url);
    if (parsed) return parsed;
  } catch {
    if (trimmed.includes("/")) {
      try {
        const fallbackUrl = new URL(`https://${trimmed.replace(/^\/+/, "")}`);
        const parsed = parseFromUrl(fallbackUrl);
        if (parsed) return parsed;
      } catch {
        // 忽略
      }
    }
  }

  throw new AppError("INVALID_PLAYLIST", "请输入网易云或 QQ 音乐歌单链接或数字 ID");
};
