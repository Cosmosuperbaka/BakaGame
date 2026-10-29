import { useRef, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { CloseButton } from "@/components/ui/CloseButton";
import { backdrop, sheetSlide, type SheetSide } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 面板标题，同时是对话框的可访问名。 */
  title: ReactNode;
  /** 面板自哪条视口边缘滑入；默认右侧，与打开它的行锚定同一条边。 */
  side?: SheetSide;
  /**
   * 退场动画播完、面板真正卸载后回调。
   * 调用处据此清掉「关闭后不再需要、但不能在关闭动画期间消失」的内容（如选中的依赖）。
   */
  onExitComplete?: () => void;
  children: ReactNode;
}

/**
 * 覆盖式侧边面板。基于 Radix Dialog：焦点锁在面板内、Esc 与点背板关闭、
 * 读屏读得到标题，关闭后焦点回到打开它的元素，这些都由 Radix 保证。
 *
 * 遮罩走 `backdrop`、面板走 `sheetSlide`，两个变体分工见 DesignGuide §8：
 * 遮罩先出现后消失，面板只做位移、沿原路边进边出。
 * 面板是固定高度外壳，标题栏固定在顶部，内容区自己滚动，长许可证原文不会把页面撑高。
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  side = "right",
  onExitComplete,
  children,
}: SheetProps) {
  // 打开一瞬间仍在焦点上的元素（触发抽屉的依赖行）。关闭时显式把焦点还给它：
  // 抽屉经 AnimatePresence 延迟卸载，Radix 的默认恢复会被退场期间的重排打断。
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {/* 退出动画播完再卸载：面板在这段时间里保持完整，不会闪一下空白。 */}
      <AnimatePresence onExitComplete={onExitComplete}>
        {open ? (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay forceMount asChild>
              <motion.div
                variants={backdrop}
                initial="initial"
                animate="animate"
                exit="exit"
                className="scrim fixed inset-0 z-overlay"
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content
              forceMount
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={() => {
                const active = document.activeElement;
                restoreFocusRef.current = active instanceof HTMLElement ? active : null;
              }}
              onCloseAutoFocus={(event) => {
                const target = restoreFocusRef.current;
                if (!target?.isConnected) return;
                event.preventDefault();
                target.focus();
              }}
            >
              <motion.aside
                custom={side}
                variants={sheetSlide}
                initial="initial"
                animate="animate"
                exit="exit"
                className={cn(
                  "fixed inset-y-0 z-modal flex w-[min(92vw,32rem)] max-w-full flex-col overflow-hidden border bg-popover text-popover-foreground shadow-lg",
                  side === "right" ? "right-0 border-l" : "left-0 border-r"
                )}
              >
                <div className="flex h-12 shrink-0 items-center gap-3 border-b pl-4 pr-2">
                  <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {title}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Close asChild>
                    <CloseButton aria-label="关闭面板" />
                  </DialogPrimitive.Close>
                </div>
                <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
                  {children}
                </div>
              </motion.aside>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
