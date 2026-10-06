import { AnimatePresence, motion } from "framer-motion";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { playerRelayout, readoutSwap } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/**
 * 玩家栏里的旁观切换入口，三个游戏共用。
 * 「加入旁观」接在旁观分组之后，「取消旁观」接在玩家分组之后，入口始终落在要去的那一组下方。
 * `queued` 表示改动要到下一局才生效（猜歌允许对局中排队），`selected` 表示已经排上。
 * 两处入口共用一个 `layoutId`：切换后入口从旧分组滑到新分组，图标与文案在途中换掉（须在 `PlayerListLayout` 内）。
 */
export function SpectatorToggle({
  spectator,
  queued = false,
  selected = false,
  disabled = false,
  className,
  onToggle,
}: {
  /** true 为「加入旁观」，false 为「取消旁观」 */
  spectator: boolean;
  queued?: boolean;
  selected?: boolean;
  disabled?: boolean;
  className?: string;
  onToggle: (spectator: boolean) => void;
}) {
  const label = queued
    ? spectator ? "下轮加入旁观" : "下轮加入游戏"
    : spectator ? "加入旁观" : "取消旁观";
  const Icon = spectator ? Eye : EyeOff;
  const text = selected ? `${label}（已选择）` : label;
  return (
    <motion.div layoutId="spectator-toggle" layout="position" transition={playerRelayout} className="mt-1 min-w-0">
      <Button
        variant={selected ? "secondary" : "ghost"}
        size="sm"
        disabled={disabled}
        className={cn("h-8 w-full min-w-0 justify-start gap-1.5 px-2 text-xs text-muted-foreground", className)}
        onClick={() => onToggle(spectator)}
      >
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span key={text} variants={readoutSwap} initial="initial" animate="animate" exit="exit" className="flex min-w-0 items-center gap-1.5">
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{text}</span>
          </motion.span>
        </AnimatePresence>
      </Button>
    </motion.div>
  );
}
