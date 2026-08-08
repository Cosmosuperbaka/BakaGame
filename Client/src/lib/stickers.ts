// 聊天表情包清单。内容由 vite.config.ts 的 sticker-manifest 插件扫描
// Client/public/emojis/ 生成，这里只负责取回并做防御性校验，不写死任何包名或表情名。

/** 贴纸消息前缀，用于识别聊天消息是贴纸而非普通文本 */
export const STICKER_PREFIX = "@@sticker@@";

export interface StickerItem {
  key: string;
  label: string;
  path: string;
  /** 该表情自身是否为动图。同一个包里可能混装动图与静图。 */
  animated: boolean;
}

export interface StickerPack {
  /** 取自 info.txt 的 `# 名称：`，缺失时退化为目录名 */
  name: string;
  /** 目录名，用作稳定的 React key */
  dir: string;
  /** 标签栏展示的代表图，取排序后的首个表情 */
  preview: string;
  /** 整包都是动图时为真；混装包为假，此时只在具体表情上标角标 */
  animated: boolean;
  items: StickerItem[];
}

const MANIFEST_URL = "/sticker-manifest.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readItem = (raw: unknown): StickerItem | null => {
  if (!isRecord(raw)) return null;
  const { key, label, path, animated } = raw;
  if (typeof key !== "string" || typeof path !== "string" || !key || !path) return null;

  return {
    key,
    label: typeof label === "string" && label ? label : key,
    path,
    animated: animated === true,
  };
};

const readPack = (raw: unknown): StickerPack | null => {
  if (!isRecord(raw)) return null;
  const { name, dir, preview, animated, items } = raw;
  if (typeof dir !== "string" || !dir) return null;

  const parsedItems = Array.isArray(items)
    ? items.map(readItem).filter((item): item is StickerItem => item !== null)
    : [];

  if (parsedItems.length === 0) return null;

  return {
    name: typeof name === "string" && name ? name : dir,
    dir,
    preview: typeof preview === "string" && preview ? preview : parsedItems[0].path,
    // 清单已算过，但混装包必须为假，因此再按条目兜底一次。
    animated: animated === true && parsedItems.every((item) => item.animated),
    items: parsedItems,
  };
};

/**
 * 取回表情包清单。清单缺失或格式异常时返回空数组，
 * 由调用方展示空态，不抛错打断聊天面板。
 */
export async function loadStickerPacks(): Promise<StickerPack[]> {
  try {
    const response = await fetch(MANIFEST_URL);
    if (!response.ok) return [];

    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.packs)) return [];

    return payload.packs.map(readPack).filter((pack): pack is StickerPack => pack !== null);
  } catch {
    return [];
  }
}
