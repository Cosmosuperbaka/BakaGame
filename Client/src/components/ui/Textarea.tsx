import * as React from "react"
import { cn } from "@/lib/Utils"

/** 多行输入框：外框与 `Input` 同为 `field-frame`，只能纵向拉伸。 */
const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(
        "field-frame flex min-h-24 w-full resize-y rounded-md bg-background px-3 py-2 text-sm",
        "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      ref={ref}
      {...props}
    />
  )
)
Textarea.displayName = "Textarea"

export { Textarea }
