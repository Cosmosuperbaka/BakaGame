import { useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

// 贴纸消息前缀，用于识别消息是贴纸而非普通文本
export const STICKER_PREFIX = "@@sticker@@";

export interface StickerItem {
  key: string;
  label: string;
  path: string;
  animated: boolean;
}

export interface StickerPack {
  name: string;
  preview: string;   // 标签栏展示的代表图
  items: StickerItem[];
}

const BASE = "/emojis";

// ==================== 表情包数据 ====================

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

export const STICKER_PACKS: StickerPack[] = [
  {
    name: MUJICA_PACK,
    preview: `${BASE}/${MUJICA_PACK}/[${MUJICA_PACK}_wink].png`,
    items: mujicaKeys.map((key) => ({
      key,
      label: key,
      path: `${BASE}/${MUJICA_PACK}/[${MUJICA_PACK}_${key}].png`,
      animated: false,
    })),
  },
  {
    name: YEYUAN_PACK,
    preview: `${BASE}/${YEYUAN_PACK}/[${YEYUAN_PACK}_鼓掌].gif`,
    items: yeyuanKeys.map((key) => ({
      key,
      label: key,
      path: `${BASE}/${YEYUAN_PACK}/[${YEYUAN_PACK}_${key}].gif`,
      animated: true,
    })),
  },
];

// ==================== 组件 ====================

interface Props {
  open: boolean;
  activeTab: number;
  onTabChange: (index: number) => void;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ open, activeTab, onTabChange, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pack = STICKER_PACKS[activeTab];

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 8, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.97 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-xl border bg-popover shadow-lg overflow-hidden"
        >
          {/* 主展示区：5 列 Grid */}
          <ScrollArea className="h-52">
            <div className="grid grid-cols-5 gap-1 p-2">
              {pack.items.map((item) => (
                <button
                  key={item.key}
                  onClick={() => { onSelect(item.path); onClose(); }}
                  className="flex flex-col items-center gap-0.5 rounded-lg p-1 hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  title={item.label}
                >
                  <div className="relative w-full aspect-square">
                    {item.animated && (
                      <span
                        className="absolute top-0.5 right-0.5 z-10 text-[8px] leading-none px-1 py-0.5 rounded-full font-semibold pointer-events-none"
                        style={{ background: "#ff4d79", color: "#fff" }}
                      >
                        动图
                      </span>
                    )}
                    <img
                      src={item.path}
                      alt={item.label}
                      draggable={false}
                      className="w-full h-full object-contain rounded"
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground leading-tight w-full text-center truncate">
                    {item.label}
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>

          {/* 底部 Tab 栏 */}
          <div className="border-t flex overflow-x-auto scrollbar-none shrink-0">
            {STICKER_PACKS.map((p, i) => (
              <button
                key={p.name}
                onClick={() => onTabChange(i)}
                title={p.name}
                className={cn(
                  "relative flex-shrink-0 w-12 h-10 flex items-center justify-center transition-colors",
                  i === activeTab
                    ? "bg-primary/15 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary after:rounded-t"
                    : "hover:bg-accent"
                )}
              >
                <img
                  src={p.preview}
                  alt={p.name}
                  draggable={false}
                  className="w-7 h-7 object-contain"
                />
              </button>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
