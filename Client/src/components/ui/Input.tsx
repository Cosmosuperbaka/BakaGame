import * as React from "react"
import { cn } from "@/lib/Utils"

/**
 * 单行输入框。外框、悬停与聚焦的晕光都由 `field-frame` 统一给出（见 index.css），
 * 校验失败（`aria-invalid`）时描边与晕光转为危险色。
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "field-frame flex h-9 w-full rounded-md bg-background px-3 py-1 text-sm",
          "placeholder:text-muted-foreground",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
