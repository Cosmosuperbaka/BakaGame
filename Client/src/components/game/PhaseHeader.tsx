import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  iconClassName?: string;
  titleClassName?: string;
}

export function PhaseHeader({
  icon: Icon,
  title,
  description,
  iconClassName,
  titleClassName,
}: Props) {
  return (
    <div className="flex flex-col items-center text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-md border bg-muted/35 shadow-xs">
        <Icon className={cn("h-5 w-5 text-foreground", iconClassName)} />
      </span>
      <h2 className={cn("mt-3 text-2xl font-semibold", titleClassName)}>{title}</h2>
      {description ? (
        <div className="mt-1 text-sm text-muted-foreground">{description}</div>
      ) : null}
    </div>
  );
}
