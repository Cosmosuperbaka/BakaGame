import { useRef, type ReactNode, type RefObject } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { CloseButton } from "@/components/ui/CloseButton";
import { useCloseFrom } from "@/hooks/UseCloseFrom";
import { backdrop, duration, ease, spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/**
 * 移动端覆盖面板（玩家、聊天、发言历史）。
 *
 * 基于 Radix Dialog：焦点锁定在面板内、Esc 与点背板关闭、读屏得到面板标题，关闭后焦点回到入口按钮。
 * 不使用 Portal：面板渲染在房间主体容器里，绝对定位只覆盖顶栏以下的区域，顶栏始终可见。
 * 自左侧滑入的是玩家与历史，自右侧滑入的是聊天，与桌面端各自栏位的方向一致。
 */
export function RoomDrawer({
  open,
  onOpenChange,
  side,
  title,
  closeFrom,
  className,
  children,
  triggerRef,
  fallbackFocusRef,
}: {
  triggerRef?: RefObject<HTMLButtonElement | null>;
  fallbackFocusRef?: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: "left" | "right";
  title: string;
  /** 该面板在此断点及以上常驻显示，视口放大越过它时自动关闭覆盖面板 */
  closeFrom: "md" | "xl";
  /** 宽度等尺寸类，默认左侧 `w-72`、右侧 `w-80` */
  className?: string;
  children: ReactNode;
}) {
  const offset = side === "left" ? "-100%" : "100%";
  const restoreFallback = useRef(false);
  useCloseFrom(open, (next) => {
    restoreFallback.current = true;
    onOpenChange(next);
  }, closeFrom);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <>
            <DialogPrimitive.Overlay forceMount asChild>
              <motion.div variants={backdrop} initial="initial" animate="animate" exit="exit" className="absolute inset-0 z-drawer bg-foreground/20 dark:bg-black/50" />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content forceMount asChild aria-describedby={undefined}
              onOpenAutoFocus={() => { restoreFallback.current = false; }}
              onCloseAutoFocus={triggerRef ? (event) => {
                event.preventDefault();
                const target = restoreFallback.current ? fallbackFocusRef?.current : triggerRef.current;
                if (target?.isConnected) target.focus();
              } : undefined}
            >
              <motion.aside
                initial={{ x: offset }}
                animate={{ x: 0, transition: spring.swift }}
                exit={{ x: offset, transition: { duration: duration.quick, ease: ease.inOut } }}
                className={cn(
                  "absolute inset-y-0 z-drawer flex min-w-0 max-w-full flex-col overflow-hidden bg-panel shadow-lg",
                  side === "left" ? "left-0 border-r" : "right-0 border-l",
                  className ?? (side === "left" ? "w-72" : "w-80"),
                )}
              >
                <div className="flex h-10 shrink-0 items-center justify-between border-b pl-3 pr-1">
                  <DialogPrimitive.Title className="text-sm font-medium">{title}</DialogPrimitive.Title>
                  <DialogPrimitive.Close asChild>
                    <CloseButton aria-label="关闭面板" />
                  </DialogPrimitive.Close>
                </div>
                <div className="min-h-0 flex-1">{children}</div>
              </motion.aside>
            </DialogPrimitive.Content>
          </>
        ) : null}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
