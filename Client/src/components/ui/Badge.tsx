import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/Utils"

/**
 * 变体按用途命名，调用处不再覆写底色、描边、字重或文字色，只加布局类与内容排版：
 * - default / secondary / destructive：实底的强调标记
 * - outline：稀疏的内容标签（年份、筛选条件、答案卡上的角色标签）
 * - muted / matched：密集的标签列表（CCB 反馈表），常规字重；matched 是命中的线索，靠描边而不只靠颜色与 muted 区分
 * - subtle / active / unavailable：卡片上的次要信息，常规字重；active 表示进行中，unavailable 表示该项不可用
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow-sm",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground shadow-sm",
        outline: "text-foreground",
        muted: "border-transparent bg-muted font-normal text-foreground",
        matched: "border-success/40 bg-success/10 font-normal text-success",
        subtle: "border-border/80 font-normal text-muted-foreground",
        active: "border-primary/40 bg-primary/10 font-normal text-primary",
        unavailable: "border-dashed border-border/60 font-normal text-muted-foreground/45",
      },
      size: {
        default: "px-2.5 py-0.5",
        // 密集表格（CCB 反馈表）里一格十几个标签，收紧内边距；py-px 抵掉描边多占的 2px，行高不因描边变高。
        sm: "px-1.5 py-px",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant, size }), className)} {...props} />
}

export { Badge }
