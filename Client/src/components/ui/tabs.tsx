import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { motion } from "framer-motion"
import { phaseSwap, spring } from "@/lib/motion"
import { cn } from "@/lib/utils"

/** 同一组 Tabs 共享的 layoutId，使激活底块在标签之间滑动而非各自淡入。 */
const TabsGroupContext = React.createContext<string | null>(null)

const Tabs = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ children, ...props }, ref) => {
  const groupId = React.useId()
  return (
    <TabsPrimitive.Root ref={ref} {...props}>
      <TabsGroupContext.Provider value={groupId}>{children}</TabsGroupContext.Provider>
    </TabsPrimitive.Root>
  )
})
Tabs.displayName = TabsPrimitive.Root.displayName

const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-9 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground",
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

/**
 * 标签。激活底块以 layoutId 在同组标签间滑动，
 * 读作同一个指示器移动到新位置，而不是两处各自淡入淡出。
 */
const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, children, ...props }, ref) => {
  const groupId = React.useContext(TabsGroupContext)
  const [active, setActive] = React.useState(false)
  const innerRef = React.useRef<HTMLButtonElement>(null)
  React.useImperativeHandle(ref, () => innerRef.current as HTMLButtonElement)

  // Radix 通过 data-state 表达激活态，这里镜像到 React 状态以驱动动画。
  React.useEffect(() => {
    const node = innerRef.current
    if (!node) return
    const sync = () => setActive(node.dataset.state === "active")
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(node, { attributes: true, attributeFilter: ["data-state"] })
    return () => observer.disconnect()
  }, [])

  return (
    <TabsPrimitive.Trigger
      ref={innerRef}
      className={cn(
        "relative inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground",
        className
      )}
      {...props}
    >
      {active && groupId ? (
        <motion.span
          layoutId={`tabs-active-${groupId}`}
          transition={spring.swift}
          className="absolute inset-0 rounded-md bg-background shadow"
        />
      ) : null}
      <span className="relative">{children}</span>
    </TabsPrimitive.Trigger>
  )
})
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

/** 面板内容随激活切换缩放淡入，与标签底块同一时序。
 * 动画结束后清除残留 transform，避免分数缩放导致文本子像素抖动。
 */
const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn(
        "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className
      )}
      {...props}
    >
      <motion.div
        ref={contentRef}
        variants={phaseSwap}
        initial="initial"
        animate="animate"
        onAnimationComplete={(definition) => {
          if (definition !== "animate") return;
          const node = contentRef.current;
          if (node) node.style.transform = "";
        }}
        style={{ willChange: "transform, opacity" }}
        className="h-full"
      >
        {children}
      </motion.div>
    </TabsPrimitive.Content>
  );
});
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
