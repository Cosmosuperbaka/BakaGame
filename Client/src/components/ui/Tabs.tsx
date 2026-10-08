import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { SlidingIndicator } from "@/components/ui/SlidingIndicator"
import { useIndicatorRect } from "@/hooks/UseIndicatorRect"
import { genieTab, tabSwap, tappable, type GeniePath } from "@/lib/Motion"
import { cn } from "@/lib/Utils"

/**
 * 当前选中值与本次切换的方向（1 往后、-1 往前、0 未知），供底块与内容同向移动。
 * 神灯切换另带两端向量：旧内容吸回自己的标签，新内容从被点的标签倒出。
 */
interface TabsMotion {
  value: string | undefined
  direction: number
  genie: boolean
  path?: GeniePath
}

const TabsMotionContext = React.createContext<TabsMotion>({ value: undefined, direction: 0, genie: false })

type TabsProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root> & {
  /** 内容切换方式：`slide` 横向交叉（`tabSwap`），`genie` 神灯吸入吐出（`genieTab`）。 */
  swap?: "slide" | "genie"
}

/** 元素中心的视口坐标。 */
function centerOf(element: Element) {
  const rect = element.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/**
 * 标签页根节点。受控与非受控都支持；切换由标签触发时按标签的先后算出方向，
 * 内容据此从目标一侧滑入。外部直接改 `value` 时方向未知，内容只交叉淡化。
 * 根节点是定位元素：切换时旧内容被抽出文档流、叠在新内容上退场。
 */
const Tabs = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.Root>, TabsProps>(
  ({ value, defaultValue, onValueChange, className, children, swap: swapStyle = "slide", ...props }, ref) => {
  const rootRef = React.useRef<HTMLDivElement>(null)
  React.useImperativeHandle(ref, () => rootRef.current as HTMLDivElement)
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue)
  const current = value ?? uncontrolled
  const genie = swapStyle === "genie"
  const reduced = useReducedMotion()
  const [swap, setSwap] = React.useState<TabsMotion>({ value: current, direction: 0, genie })
  if (swap.value !== current || swap.genie !== genie) setSwap({ value: current, direction: 0, genie })

  /** 神灯两端：面板中心分别指向旧标签与新标签。并列面板同高同位，量当前这块即可。 */
  const measurePath = (tabs: HTMLElement[], next: string): GeniePath | undefined => {
    const panel = rootRef.current?.querySelector(':scope > [role="tabpanel"]')
    if (!panel) return undefined
    const center = centerOf(panel)
    const toward = (target: string | undefined) => {
      const tab = tabs.find((item) => item.dataset.value === target)
      if (!tab) return undefined
      const point = centerOf(tab)
      return { dx: point.x - center.x, dy: point.y - center.y }
    }
    return { enter: toward(next), exit: toward(current) }
  }

  const change = (next: string) => {
    const tabs = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="tab"][data-value]') ?? [])
    const order = tabs.map((tab) => tab.dataset.value)
    const from = current === undefined ? -1 : order.indexOf(current)
    const to = order.indexOf(next)
    setSwap({
      value: next,
      direction: from < 0 || to < 0 ? 0 : Math.sign(to - from),
      genie,
      path: genie && !reduced ? measurePath(tabs, next) : undefined,
    })
    if (value === undefined) setUncontrolled(next)
    onValueChange?.(next)
  }

  return (
    <TabsPrimitive.Root ref={rootRef} value={current} onValueChange={change} className={cn("relative", className)} {...props}>
      <TabsMotionContext.Provider value={swap}>{children}</TabsMotionContext.Provider>
    </TabsPrimitive.Root>
  )
  },
)
Tabs.displayName = TabsPrimitive.Root.displayName

/**
 * 标签栏：一排文字标签压在一条细分隔线上，选中项底部是一道主色细线（`SlidingIndicator shape="underline"`）。
 * 细线是栏里唯一的一个元素，按量到的选中标签位置滑动（`useIndicatorRect`），
 * 不靠 layoutId 交接：弹窗缩放开合、重新打开时都停在原位，不会从别处飞进来。
 * 与下方内容的间距由调用处给标签栏加下外边距（`mb-4` 等），`TabsContent` 不写外边距（见 `TabsContent`）。
 */
const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, children, ...props }, ref) => {
  const { value } = React.useContext(TabsMotionContext)
  const listRef = React.useRef<HTMLDivElement>(null)
  React.useImperativeHandle(ref, () => listRef.current as HTMLDivElement)
  const rect = useIndicatorRect(listRef, '[data-state="active"]', value)
  return (
    <TabsPrimitive.List
      ref={listRef}
      className={cn(
        "relative inline-flex h-10 items-stretch justify-start gap-1 border-b border-border text-muted-foreground",
        className
      )}
      {...props}
    >
      <SlidingIndicator rect={rect} shape="underline" />
      {children}
    </TabsPrimitive.List>
  )
})
TabsList.displayName = TabsPrimitive.List.displayName

/** 标签。按压走 tappable：CSS 的 active:scale 没有过渡、按下松开都是硬切，也不受减弱动效约束。 */
const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <TabsPrimitive.Trigger ref={ref} asChild data-value={props.value} {...props}>
    <motion.button
      type="button"
      {...tappable}
      className={cn(
        // 标签贴在分隔线上（-mb-px 盖住那 1px），聚焦环向内收，不被弹窗边缘或分隔线切掉。
        "relative -mb-px inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-t-md px-3 text-sm font-medium transition-colors hover:text-foreground focus-visible:-outline-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground",
        className
      )}
    >
      {children}
    </motion.button>
  </TabsPrimitive.Trigger>
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

/**
 * 标签内容。切换时新内容从目标标签一侧滑入、旧内容向另一侧让出（`tabSwap`），与底块同向；
 * 旧内容经 popLayout 抽出文档流叠在原位退场，两块内容交叉而不是先清空再出现。
 * 首次挂载不播放：所在弹窗或面板自己有入场，内容不再叠一层。
 * 抽出文档流按边框盒定位，外边距会让退场内容错开一截，所以内容不写外边距，间距交给 `TabsList`。
 * 动画结束清除残留 transform，避免文本停在子像素位移上（Animation §4.3）。
 * 根节点 `swap="genie"` 时改走 `genieTab`：旧内容吸回自己的标签、新内容从被点的标签倒出，落定后一并清掉裁切。
 */
const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, children, value, ...props }, ref) => {
  const { value: active, direction, genie, path } = React.useContext(TabsMotionContext)
  const custom = genie ? path : direction
  const contentRef = React.useRef<HTMLDivElement>(null)
  React.useImperativeHandle(ref, () => contentRef.current as HTMLDivElement)
  const selected = active === value

  return (
    <AnimatePresence initial={false} mode="popLayout" custom={custom}>
      {selected ? (
        <TabsPrimitive.Content key={value} ref={contentRef} value={value} {...props} forceMount asChild>
          <motion.div
            custom={custom}
            variants={genie ? genieTab : tabSwap}
            initial="initial"
            animate="animate"
            exit="exit"
            onAnimationComplete={(definition) => {
              if (definition !== "animate") return
              const node = contentRef.current
              if (!node) return
              node.style.transform = ""
              if (genie) node.style.clipPath = ""
            }}
            className={className}
          >
            {children}
          </motion.div>
        </TabsPrimitive.Content>
      ) : null}
    </AnimatePresence>
  )
})
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
