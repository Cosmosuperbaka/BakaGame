import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { AnimatePresence, motion } from "framer-motion"
import { X } from "lucide-react"
import {
  backdrop,
  emergeFromOrigin,
  iconTappable,
  useOriginStyle,
  type OriginPoint,
} from "@/lib/Motion"
import { cn } from "@/lib/Utils"

const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

/** 由 Root 向 Content 传递本次打开的来源坐标，用于锚定浮层缩放原点。 */
const DialogOriginContext = React.createContext<OriginPoint | null>(null)

interface DialogProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root> {
  /** 触发按钮的视口中心点；浮层由此处展开与收回。 */
  origin?: OriginPoint | null
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
      className={cn("fixed inset-0 z-50 bg-foreground/25 backdrop-blur-[2px]", className)}
    />
  </DialogPrimitive.Overlay>
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const origin = React.useContext(DialogOriginContext)
  const innerRef = React.useRef<HTMLDivElement>(null)
  React.useImperativeHandle(ref, () => innerRef.current as HTMLDivElement)
  const originStyle = useOriginStyle(innerRef, origin)

  return (
    <DialogPortal forceMount>
      <DialogOverlay />
      <DialogPrimitive.Content asChild {...props}>
        <motion.div
          ref={innerRef}
          variants={emergeFromOrigin}
          initial="initial"
          animate="animate"
          exit="exit"
          style={originStyle}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 grid max-h-[90vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2",
            "scrollbar-hidden gap-4 overflow-y-auto rounded-xl border bg-popover p-6 text-popover-foreground shadow-lg",
            className
          )}
        >
          {children}
          <DialogPrimitive.Close asChild>
            <motion.button
              type="button"
              {...iconTappable}
              className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">关闭</span>
            </motion.button>
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
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
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
