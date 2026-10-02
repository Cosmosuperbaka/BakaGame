import * as React from "react"
import { X } from "lucide-react"
import { Button, type ButtonProps } from "@/components/ui/Button"
import { cn } from "@/lib/Utils"

type CloseButtonProps = Omit<ButtonProps, "children" | "variant" | "size">

/**
 * 弹窗、覆盖面板与内嵌面板共用的关闭按钮：低强调的 ghost 图标钮，默认可访问名「关闭」。
 * 需要 Radix 的关闭语义时包在 `Close asChild` 里。
 */
const CloseButton = React.forwardRef<HTMLButtonElement, CloseButtonProps>(
  ({ className, "aria-label": ariaLabel = "关闭", ...props }, ref) => (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon"
      aria-label={ariaLabel}
      className={cn("h-8 w-8 shrink-0 text-muted-foreground", className)}
      {...props}
    >
      <X />
    </Button>
  )
)
CloseButton.displayName = "CloseButton"

export { CloseButton }
