import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  icon: LucideIcon;
  title: string;
  /** 兼容现有调用；阶段副标题不再渲染。 */
  description?: ReactNode;
  iconClassName?: string;
  titleClassName?: string;
}

export function PhaseHeader({
  icon: Icon,
  title,
  iconClassName,
  titleClassName,
}: Props) {
  return (
    <div className="flex min-h-[5.5rem] flex-col items-center justify-start text-center">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
        <Icon className={cn("h-5 w-5 text-foreground", iconClassName)} />
      </span>
      <h2 className={cn("mt-3 text-2xl font-semibold leading-8", titleClassName)}>{title}</h2>
    </div>
  );
}
