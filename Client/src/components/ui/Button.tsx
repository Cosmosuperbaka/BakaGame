import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { motion, type HTMLMotionProps } from "framer-motion";
import { cva, type VariantProps } from "class-variance-authority";
import { Spinner } from "@/components/ui/Spinner";
import { iconTappable, pressable, pressableStrong } from "@/lib/motion/Feedback";
import { cn } from "@/lib/Utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-serif font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer",
  {
    variants: {
      variant: {
        // 聚焦环与主色同色（--ring = --primary）：贴边画在主色实底上只像按钮胖了 2px，外移一格让页面底色把环与按钮隔开。
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-offset-2",
        // 危险色与聚焦环同为高明度（暗色 1.04:1、亮色也同档），贴边的环会融进实底，与 default 一样外移留缝。
        destructive:
          "bg-destructive-solid text-destructive-foreground shadow-sm hover:bg-destructive-solid/90 focus-visible:outline-offset-2",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        // secondary/80 与原色只差几级亮度，两种主题下悬停都几乎看不出；换成 accent，与 outline、ghost 的悬停底同一档。
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-accent",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        // 行内操作（玩家栏、测试控制器）一行放不下 sm 的高度，比它再矮一档。
        xs: "h-7 rounded-md px-2 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
        "icon-xs": "h-5 w-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends Omit<HTMLMotionProps<"button">, "children">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  children?: React.ReactNode;
  loading?: boolean;
}

/**
 * 按压反馈随变体分级：主要与危险操作幅度更大，确认感更强；
 * 图标钮（size 为 icon、icon-sm、icon-xs）不分变体，一律 iconTappable，连同图标一起下沉；
 * link 是文本入口，只保留下划线，不做尺度变化。
 * asChild 交由外层元素承担交互，此时不叠加动效避免双重缩放。
 * loading 态强制禁用并展示 spinner，抑制悬浮与点击缩放。
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, disabled, loading = false, children, ...props },
    ref
  ) => {
    const effectiveVariant = variant ?? "default";
    const classes = cn(buttonVariants({ variant: effectiveVariant, size, className }));
    const isDisabled = Boolean(disabled || loading);

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
      );
    }

    const feedback =
      effectiveVariant === "link"
        ? undefined
        : size === "icon" || size === "icon-sm" || size === "icon-xs"
          ? iconTappable
          : effectiveVariant === "default" || effectiveVariant === "destructive"
            ? pressableStrong
            : pressable;

    return (
      <motion.button
        // 没写类型就是普通按钮：放进表单不该顺手变成提交钮，要提交的调用点显式写 type="submit"。
        type="button"
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
    );
  }
);
Button.displayName = "Button";

export { Button };
