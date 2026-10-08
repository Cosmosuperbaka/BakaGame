import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { AnimatePresence, motion } from "framer-motion"
import { CloseButton } from "@/components/ui/CloseButton"
import {
  backdrop,
  emergeFromOrigin,
  flingVector,
  flingWindow,
  useOriginStyle,
  type OriginPoint,
} from "@/lib/Motion"
import { cn } from "@/lib/Utils"

const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

/** 由 Root 向 Content 传递本次打开的来源坐标与开合方式。 */
const DialogOriginContext = React.createContext<{ origin: OriginPoint | null; fling: boolean }>({ origin: null, fling: false })

interface DialogProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root> {
  /** 触发按钮的视口中心点；浮层由此处展开与收回。 */
  origin?: OriginPoint | null
  /**
   * 抛掷开合（`flingWindow`）：弹窗带着动量从触发按钮里被抛出来、关闭时吸回按钮，用于主页的版本信息这类
   * 从一个小入口打开整块内容的窗口。缺省走 `emergeFromOrigin` 的原地缩放。
   */
  fling?: boolean
}

/**
 * 弹窗根节点。用 AnimatePresence 接管开合，
 * 使 Radix 卸载前先播完退出动画。
 */
function Dialog({ open, origin = null, fling = false, children, ...props }: DialogProps) {
  const value = React.useMemo(() => ({ origin, fling }), [origin, fling])
  return (
    <DialogPrimitive.Root open={open} {...props}>
      <DialogOriginContext.Provider value={value}>
        <AnimatePresence>{open ? children : null}</AnimatePresence>
      </DialogOriginContext.Provider>
    </DialogPrimitive.Root>
  )
}

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay ref={ref} asChild {...props}>
    <motion.div
      variants={backdrop}
      initial="initial"
      animate="animate"
      exit="exit"
      className={cn("fixed inset-0 z-overlay bg-foreground/25 backdrop-blur-[2px] dark:bg-black/50", className)}
    />
  </DialogPrimitive.Overlay>
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const { origin, fling } = React.useContext(DialogOriginContext)
  const innerRef = React.useRef<HTMLDivElement>(null)
  React.useImperativeHandle(ref, () => innerRef.current as HTMLDivElement)
  const originStyle = useOriginStyle(innerRef, fling ? null : origin)
  // 弹窗固定居中，中心就是视口中心：打开前即可算出抛掷向量，不必等挂载后测量。开合走同一条路。
  const vector = React.useMemo(() => (fling ? flingVector(origin) : undefined), [fling, origin])

  return (
    <DialogPortal forceMount>
      <DialogOverlay />
      <DialogPrimitive.Content asChild {...props}>
        <motion.div
          ref={innerRef}
          variants={fling ? flingWindow : emergeFromOrigin}
          custom={vector}
          initial="initial"
          animate="animate"
          exit="exit"
          style={fling ? undefined : originStyle}
          className={cn(
            // 窄屏两侧各留 1rem：先从宽度里扣掉边距再居中；mx-4 配 w-full 会把右缘推出视口。
            "fixed left-1/2 top-1/2 z-modal grid max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2",
            "scrollbar-hidden gap-4 overflow-y-auto rounded-md border bg-popover p-6 text-popover-foreground shadow-lg",
            className
          )}
        >
          {children}
          <DialogPrimitive.Close asChild>
            <CloseButton className="absolute right-3 top-3" />
          </DialogPrimitive.Close>
        </motion.div>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 pr-8 text-left", className)} {...props} />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none", className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
