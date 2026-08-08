// 聊天表情包数据。与 EmojiPicker 组件分离，避免同一文件混合导出组件与常量。

/** 贴纸消息前缀，用于识别聊天消息是贴纸而非普通文本 */
export const STICKER_PREFIX = "@@sticker@@";

export interface StickerItem {
  key: string;
  label: string;
  path: string;
}

export interface StickerPack {
  name: string;
  /** 标签栏展示的代表图 */
  preview: string;
  /** 整包是否为动图，决定标签栏角标 */
  animated: boolean;
  items: StickerItem[];
}

const BASE = "/emojis";

const MUJICA_PACK = "mujica夜愿华章表情包";
const YEYUAN_PACK = "夜愿华章表情包";

const mujicaKeys = [
  "wink", "五冠王", "伸懒腰", "分你一半", "加个好友",
  "呐喊", "哟豁", "哦", "哭哭", "唱歌",
  "坏坏", "害羞", "小祥", "开门", "思考",
  "恭敬", "抱抱", "接电话", "撩发", "是秘密哦",
  "没收", "点赞", "真谄媚啊", "难道说", "雨天",
];

const yeyuanKeys = [
  "wink", "不可以", "伸手", "再见", "叫我吗",
  "哇", "喜极而泣", "帅气抹脸", "张望", "摇摇",
  "摘墨镜", "生气", "豪饮", "领域展开", "鼓掌",
];

/** 按包名与扩展名批量生成条目路径 */
function buildItems(pack: string, keys: string[], ext: string): StickerItem[] {
  return keys.map((key) => ({
    key,
    label: key,
    path: `${BASE}/${pack}/[${pack}_${key}].${ext}`,
  }));
}

export const STICKER_PACKS: StickerPack[] = [
  {
    name: MUJICA_PACK,
    preview: `${BASE}/${MUJICA_PACK}/[${MUJICA_PACK}_wink].png`,
    animated: false,
    items: buildItems(MUJICA_PACK, mujicaKeys, "png"),
  },
  {
    name: YEYUAN_PACK,
    preview: `${BASE}/${YEYUAN_PACK}/[${YEYUAN_PACK}_鼓掌].gif`,
    animated: true,
    items: buildItems(YEYUAN_PACK, yeyuanKeys, "gif"),
  },
];
