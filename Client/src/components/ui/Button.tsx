import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { motion, type HTMLMotionProps } from "framer-motion"
import { cva, type VariantProps } from "class-variance-authority"
import { Spinner } from "@/components/ui/Spinner"
import { iconTappable, pressable, pressableStrong } from "@/lib/Motion"
import { cn } from "@/lib/Utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline: "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends Omit<HTMLMotionProps<"button">, "children">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  children?: React.ReactNode
  loading?: boolean
}

/**
 * 按压反馈随变体分级：主要与危险操作幅度更大，确认感更强；
 * 图标钮（size="icon"）不分变体，一律 iconTappable，连同图标一起下沉；
 * link 是文本入口，只保留下划线，不做尺度变化。
 * asChild 交由外层元素承担交互，此时不叠加动效避免双重缩放。
 * loading 态强制禁用并展示 spinner，抑制悬浮与点击缩放。
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, disabled, loading = false, children, ...props }, ref) => {
    const effectiveVariant = variant ?? "default";
    const classes = cn(buttonVariants({ variant: effectiveVariant, size, className }))
    const isDisabled = Boolean(disabled || loading)

    if (asChild) {
      return (
        <Slot
          className={classes}
          ref={ref}
          aria-busy={loading ? true : undefined}
          {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        >
          {children}
        </Slot>
      )
    }

    const feedback =
      effectiveVariant === "link"
        ? undefined
        : size === "icon"
          ? iconTappable
          : effectiveVariant === "default" || effectiveVariant === "destructive"
            ? pressableStrong
            : pressable

    return (
      <motion.button
        className={classes}
        ref={ref}
        disabled={isDisabled}
        aria-busy={loading ? true : undefined}
        {...(isDisabled ? undefined : feedback)}
        {...props}
      >
        {loading ? <Spinner data-testid="button-spinner" /> : null}
        {children}
      </motion.button>
    )
  }
)
Button.displayName = "Button"

export { Button }
