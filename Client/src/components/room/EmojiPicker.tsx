import { useRef, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ScrollArea } from "@/components/ui/scroll-area";
import { popover } from "@/lib/motion";
import { loadStickerPacks, type StickerPack } from "@/lib/stickers";
import { cn } from "@/lib/utils";

/** 动图角标。整包都是动图时挂在标签上，混装包挂在具体表情上。 */
function AnimatedBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute z-10 rounded-md bg-destructive px-1 py-0.5 text-xs font-semibold leading-none text-destructive-foreground",
        className,
      )}
    >
      动图
    </span>
  );
}

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
  const [packs, setPacks] = useState<StickerPack[]>([]);
  const [loaded, setLoaded] = useState(false);
  // 清单可能比 activeTab 短（目录被删），落到首个包而不是崩在 undefined 上。
  const pack = packs[activeTab] ?? packs[0];

  // 清单只在首次打开时取一次，之后常驻内存。
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;

    void loadStickerPacks().then((result) => {
      if (cancelled) return;
      setPacks(result);
      setLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

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
          variants={popover}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{ originY: 1 }}
          className="absolute bottom-full left-0 right-0 z-50 mb-1 overflow-hidden rounded-xl border bg-background/95 shadow-lg backdrop-blur-md"
        >
          {!pack ? (
            <div className="flex h-52 items-center justify-center px-4 text-center text-xs text-muted-foreground">
              {loaded ? "暂无可用表情包" : "正在载入表情包..."}
            </div>
          ) : (
          <>
          {/* 主展示区：5 列 Grid */}
          <ScrollArea className="h-52">
            <div className="grid grid-cols-5 gap-1 p-2">
              {pack.items.map((item) => (
                <button
                  key={item.key}
                  onClick={() => { onSelect(item.path); onClose(); }}
                  className="flex flex-col items-center gap-0.5 rounded-md p-1 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  title={item.label}
                >
                  <div className="relative aspect-square w-full">
                    <img
                      src={item.path}
                      alt={item.label}
                      draggable={false}
                      className="h-full w-full rounded-md object-contain"
                    />
                    {/* 整包都是动图时角标已挂在标签上，这里只标混装包里的动图 */}
                    {item.animated && !pack.animated && (
                      <AnimatedBadge className="right-0 top-0 scale-90" />
                    )}
                  </div>
                  <span className="w-full truncate text-center text-[10px] leading-tight text-muted-foreground">
                    {item.label}
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>

          {/* 底部 Tab 栏 */}
          <div
            role="tablist"
            aria-label="表情包分类"
            className="scrollbar-hidden flex shrink-0 overflow-x-auto border-t"
          >
            {packs.map((p, i) => (
              <button
                key={p.dir}
                role="tab"
                onClick={() => onTabChange(i)}
                title={p.name}
                aria-label={p.name}
                aria-selected={i === activeTab}
                className={cn(
                  "relative flex h-12 w-14 flex-shrink-0 items-center justify-center transition-colors",
                  i === activeTab
                    ? "bg-accent text-accent-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary"
                    : "hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <img
                  src={p.preview}
                  alt={p.name}
                  draggable={false}
                  className="h-8 w-8 object-contain"
                />
                {p.animated && <AnimatedBadge className="right-0 top-0" />}
              </button>
            ))}
          </div>
          </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
