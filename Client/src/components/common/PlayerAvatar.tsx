import { cn } from "@/lib/Utils";

/**
 * 玩家行左端的首字方块。尺寸必须与历史实现保持一致（`h-8 w-8`）：
 * 玩家列与发言历史的逐行对齐依赖同一行高与同一首列宽，换渲染方式不得改尺寸。
 * 只作昵称旁的身份提示，不编码得分或在线状态。
 */
export function PlayerAvatar({ name, me = false, className }: { name: string; me?: boolean; className?: string }) {
  const initial = Array.from(name)[0] ?? "?";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm leading-none",
        me ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
        className,
      )}
    >
      {initial}
    </span>
  );
}
