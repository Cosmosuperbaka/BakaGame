import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { CloseButton } from "@/components/ui/CloseButton";
import { OverlayBackdrop } from "@/components/ui/OverlayBackdrop";
import { useOriginStyle } from "@/hooks/UseOriginStyle";
import { useScrollFade } from "@/hooks/UseScrollFade";
import { emergeFromOrigin, type OriginPoint } from "@/lib/motion/Origin";
import { cn } from "@/lib/Utils";

const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

/** 由 Root 向 Content 传递本次打开的来源坐标。 */
const DialogOriginContext = React.createContext<OriginPoint | null>(null);

interface DialogProps extends Omit<
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>,
  "open" | "defaultOpen"
> {
  /** 只支持受控：开合要交给 AnimatePresence 接管，缺省时子树永远不渲染。 */
  open: boolean;
  /** 触发按钮的视口中心点；浮层由此处展开与收回。 */
  origin?: OriginPoint | null;
}

/**
 * 弹窗根节点。用 AnimatePresence 接管开合，
 * 使 Radix 卸载前先播完退出动画。
 */
function Dialog({ open, origin = null, children, ...props }: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} {...props}>
      <DialogOriginContext.Provider value={origin}>
        <AnimatePresence>{open ? children : null}</AnimatePresence>
      </DialogOriginContext.Provider>
    </DialogPrimitive.Root>
  );
}

interface DialogContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  /** 窗口外框：宽度档等。正文的内边距与间距改写在 `bodyClassName`。 */
  className?: string;
  /** 正文滚动区：默认 `grid gap-4 p-6`，需要贴边排版的弹窗在这里收掉内边距。 */
  bodyClassName?: string;
}

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  ({ className, bodyClassName, children, ...props }, ref) => {
    const origin = React.useContext(DialogOriginContext);
    const [, bodyRef] = useScrollFade<HTMLDivElement>("y");
    // 缩放原点落在触发按钮上：窗口从按钮里被吸出来，关闭时沿同一原点收回（DesignGuide §8）。
    // 原点在节点挂上时测量：Portal 首帧不挂子树，要等节点真正出现。
    const { style: originStyle, measure } = useOriginStyle(origin);
    const setRefs = React.useCallback(
      (element: HTMLDivElement | null) => {
        measure(element);
        if (typeof ref === "function") ref(element);
        else if (ref) ref.current = element;
      },
      [measure, ref]
    );

    return (
      <DialogPortal forceMount>
        {/* 每个弹窗的遮罩与窗口自成一层：后开的确认框连同它的遮罩整层压在先开的弹窗之上，
          把底下的弹窗一并压暗，而不是只压暗页面、让两个窗口平铺在同一层上互相露边。
          零尺寸的定位层不拦截指针，固定定位的子元素仍按视口落位。 */}
        <div className="relative z-modal">
          <DialogPrimitive.Overlay asChild>
            <OverlayBackdrop placement="viewport" />
          </DialogPrimitive.Overlay>
          <DialogPrimitive.Content asChild {...props}>
            <motion.div
              ref={setRefs}
              variants={emergeFromOrigin}
              initial="initial"
              animate="animate"
              exit="exit"
              style={originStyle}
              className={cn(
                // 窄屏两侧各留 1rem：先从宽度里扣掉边距再居中；mx-4 配 w-full 会把右缘推出视口。
                "fixed left-1/2 top-1/2 z-modal flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col",
                "overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg",
                className
              )}
            >
              {/* 超出 90vh 时只有正文滚动：外框的描边、圆角与投影不被遮罩裁掉，关闭钮停在右上角；
            还有内容的那一头边缘淡出，读得出页脚的按钮在下面（DesignGuide §7）。 */}
              <div
                ref={bodyRef}
                className={cn(
                  "scrollbar-hidden scroll-fade-y grid min-h-0 gap-4 p-6 [--scroll-fade-size:2rem]",
                  bodyClassName
                )}
              >
                {children}
              </div>
              <DialogPrimitive.Close asChild>
                <CloseButton className="absolute right-3 top-3" />
              </DialogPrimitive.Close>
            </motion.div>
          </DialogPrimitive.Content>
        </div>
      </DialogPortal>
    );
  }
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 pr-8 text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
