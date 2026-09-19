import { UserRound } from "lucide-react";
import { cn } from "@/lib/Utils";

/** 与玩家昵称并排展示的默认头像，不承载身份或对局状态。 */
export function PlayerAvatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
        className,
      )}
    >
      <UserRound className="h-4 w-4" />
    </span>
  );
}
