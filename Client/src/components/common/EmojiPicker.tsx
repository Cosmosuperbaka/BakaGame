import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { motion, AnimatePresence } from "framer-motion";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { Hint } from "@/components/ui/Tooltip";
import { headerTappable, popover, tappable } from "@/lib/Motion";
import { loadStickerPacks, type StickerPack } from "@/lib/Stickers";
import { cn } from "@/lib/Utils";

/** 动图角标。标的是内容类型而不是状态，取中性的 secondary。整包都是动图时挂在标签上，混装包挂在具体表情上。 */
function AnimatedBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute rounded-md bg-secondary px-1 py-0.5 text-2xs font-semibold leading-none text-secondary-foreground",
        className
      )}
    >
      动图
    </span>
  );
}

// ==================== 组件 ====================

/** 贴纸格的列数：上下方向键一次跨一整行。与下面 grid-cols-5 保持一致。 */
const GRID_COLUMNS = 5;

/** 贴纸格里的方向键导航：格子都是按钮，Tab 仍能逐个到达，方向键只是更快的走法。 */
function moveInGrid(event: KeyboardEvent<HTMLElement>) {
  const step: Record<string, number> = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -GRID_COLUMNS,
    ArrowDown: GRID_COLUMNS,
  };
  const cells = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button"));
  const from = cells.indexOf(document.activeElement as HTMLElement);
  if (from < 0) return;
  let to: number;
  if (event.key === "Home") to = 0;
  else if (event.key === "End") to = cells.length - 1;
  else if (event.key in step) to = from + step[event.key];
  else return;
  event.preventDefault();
  cells[Math.min(cells.length - 1, Math.max(0, to))]?.focus();
}

interface Props {
  open: boolean;
  activeTab: number;
  onTabChange: (index: number) => void;
  onSelect: (path: string) => void;
}

/**
 * 表情选择器的浮层。必须放在调用方的 `Popover.Root` 里：开合、点触发钮不当作「点外面」、
 * Esc 关闭、焦点进出都由 Popover 负责，调用方用 `Popover.Anchor` 圈出面板对齐的那一行。
 * 面板宽度取锚点宽度，贴着锚点上沿展开，不翻到下方（下方就是输入框）。
 */
export function EmojiPicker({ open, activeTab, onTabChange, onSelect }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
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

  return (
    <AnimatePresence>
      {open && (
        <Popover.Portal forceMount>
          <Popover.Content
            ref={panelRef}
            forceMount
            asChild
            side="top"
            align="start"
            sideOffset={3}
            avoidCollisions={false}
            aria-label="表情包"
            // 焦点落在面板本身而不是第一枚表情：落到按钮上会无故弹出它的悬停说明。
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              panelRef.current?.focus();
            }}
          >
            <motion.div
              variants={popover}
              initial="initial"
              animate="animate"
              exit="exit"
              style={{ originY: 1 }}
              tabIndex={-1}
              className="z-popover w-(--radix-popover-trigger-width) overflow-hidden floating-surface shadow-md outline-none"
            >
              {!pack ? (
                <div className="flex h-52 items-center justify-center px-4 text-center text-xs text-muted-foreground">
                  {loaded ? "暂无可用表情包" : "正在载入表情包..."}
                </div>
              ) : (
                <TabsPrimitive.Root
                  value={pack.dir}
                  onValueChange={(dir) =>
                    onTabChange(
                      Math.max(
                        0,
                        packs.findIndex((p) => p.dir === dir)
                      )
                    )
                  }
                >
                  {/* 主展示区：5 列 Grid。面板里已有可聚焦的表情，面板本身不进 Tab 序。 */}
                  <TabsPrimitive.Content value={pack.dir} asChild tabIndex={-1}>
                    <ScrollArea className="h-52" onKeyDown={moveInGrid}>
                      <div className="grid grid-cols-5 gap-1 p-2">
                        {pack.items.map((item) => (
                          <Hint key={item.key} label={item.label}>
                            <motion.button
                              type="button"
                              {...tappable}
                              onClick={() => onSelect(item.path)}
                              className="flex flex-col items-center gap-0.5 rounded-md p-1 transition-colors hover:bg-accent hover:text-accent-foreground"
                            >
                              <div className="relative aspect-square w-full">
                                <img
                                  src={item.path}
                                  alt={item.label}
                                  className="h-full w-full rounded-md object-contain"
                                />
                                {/* 整包都是动图时角标已挂在标签上，这里只标混装包里的动图 */}
                                {item.animated && !pack.animated && (
                                  <AnimatedBadge className="right-0 top-0" />
                                )}
                              </div>
                              <span className="w-full truncate text-center text-2xs leading-tight text-muted-foreground">
                                {item.label}
                              </span>
                            </motion.button>
                          </Hint>
                        ))}
                      </div>
                    </ScrollArea>
                  </TabsPrimitive.Content>

                  {/* 底部 Tab 栏 */}
                  <TabsPrimitive.List
                    aria-label="表情包分类"
                    className="scrollbar-hidden flex shrink-0 overflow-x-auto border-t"
                  >
                    {packs.map((p) => (
                      <Hint key={p.dir} label={p.name}>
                        <TabsPrimitive.Trigger value={p.dir} asChild>
                          <motion.button
                            type="button"
                            {...headerTappable}
                            aria-label={p.name}
                            className={cn(
                              // 标签栏横向滚动会裁掉外扩的环，聚焦环向内收。
                              "relative flex h-12 w-14 flex-shrink-0 items-center justify-center transition-colors focus-visible:-outline-offset-2",
                              p.dir === pack.dir
                                ? "bg-accent text-accent-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary"
                                : "hover:bg-accent hover:text-accent-foreground"
                            )}
                          >
                            <img src={p.preview} alt={p.name} className="h-8 w-8 object-contain" />
                            {/* 角标收进页签右上角、离上沿一格：贴着 top-0 会压住标签栏的分隔线，读成浮在两区之间的碎片 */}
                            {p.animated && <AnimatedBadge className="right-0.5 top-1" />}
                          </motion.button>
                        </TabsPrimitive.Trigger>
                      </Hint>
                    ))}
                  </TabsPrimitive.List>
                </TabsPrimitive.Root>
              )}
            </motion.div>
          </Popover.Content>
        </Popover.Portal>
      )}
    </AnimatePresence>
  );
}
