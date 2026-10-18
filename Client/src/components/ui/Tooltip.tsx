import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/Utils";

/** 标记上游已经挂过 Provider：`Hint` 只在缺失时补一个，避免整站多套排程。 */
const HasProvider = React.createContext(false);

/** 与 Radix 同名同参，额外把「已挂载」写进自己的上下文，供 `Hint` 判断。 */
function TooltipProvider(props: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <HasProvider.Provider value>
      <TooltipPrimitive.Provider {...props} />
    </HasProvider.Provider>
  );
}

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

/** 浮层内容的可调参数，与 `TooltipContent` 的落位口径一致。 */
type TooltipPlacement = Pick<
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>,
  "side" | "align" | "sideOffset"
>;

export interface HintProps extends TooltipPlacement {
  /** 悬停文案；为空时退化成不带浮层的原元素，与 `title={undefined}` 同口径。 */
  label?: string | null | false;
  /** 触发元素，必须能接收 ref（原生标签或转发 ref 的组件）。 */
  children: React.ReactNode;
  /** 追加到浮层内容上的类名，调用处不再覆写圆角、描边或底色。 */
  contentClassName?: string;
}

/**
 * 统一的悬停说明，替代浏览器原生 `title`：原生浮层不进设计系统的表面与动效，样式由系统决定且不可控。
 * 文案为空时不挂浮层，调用处不必为可空文案分叉。
 * Radix 的 `Tooltip` 没有 Provider 会直接抛错，而业务组件在测试、Storybook 里常被单独渲染：
 * 上游已有 Provider 时（App 根节点）共用它的排程，缺失时才补一个兜底，不让调用方为此套一层。
 */
function Hint({ label, children, contentClassName, ...placement }: HintProps) {
  const hasProvider = React.useContext(HasProvider);
  if (!label) return <>{children}</>;
  const floating = (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className={contentClassName} {...placement}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
  return hasProvider ? floating : <TooltipProvider>{floating}</TooltipProvider>;
}

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        // 开合动画在 index.css；原点取 Radix 按实际落位（含避让翻转）给出的方向，读作从触发元素长出来。
        "z-popover overflow-hidden floating-surface px-3 py-1.5 text-xs text-foreground shadow-md origin-(--radix-tooltip-content-transform-origin)",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Hint, Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
