import { useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ScrollArea } from "@/components/ui/scroll-area";
import { popover } from "@/lib/motion";
import { STICKER_PACKS } from "@/lib/stickers";
import { cn } from "@/lib/utils";

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
          variants={popover}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{ originY: 1 }}
          className="absolute bottom-full left-0 right-0 z-50 mb-1 overflow-hidden rounded-xl border bg-secondary text-secondary-foreground shadow-lg"
        >
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
                  </div>
                  <span className="w-full truncate text-center text-[10px] leading-tight text-secondary-foreground/70">
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
            className="flex shrink-0 overflow-x-auto border-t border-secondary-foreground/15"
          >
            {STICKER_PACKS.map((p, i) => (
              <button
                key={p.name}
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
                {p.animated && (
                  <span
                    className="pointer-events-none absolute right-0 top-0 z-10 rounded-md px-1 py-0.5 text-xs font-semibold leading-none"
                    style={{ background: "#ff4d79", color: "#fff" }}
                  >
                    动图
                  </span>
                )}
              </button>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
