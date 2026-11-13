import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "@/lib/Utils";

/**
 * 账号类弹窗里的请求失败说明：前导图标 + 危险色正文，字号与字段说明同为 xs。
 * 状态不只靠颜色传达（DesignGuide §3），与提示条的语义图标同一口径；
 * 登录、资料与反馈三个弹窗原先各写一行裸红字，字号 xs 与 sm 混用。
 */
export function FormAlert({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      role="alert"
      className={cn("flex items-start gap-1.5 text-xs leading-relaxed text-destructive", className)}
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
