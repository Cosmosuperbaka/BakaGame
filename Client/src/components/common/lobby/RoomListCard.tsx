import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { Eye, EyeOff, Lock, Users } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card, CardContent } from "@/components/ui/Card";
import { listItem, selectable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/** 大厅卡片的展示模型；各游戏把自己的房间摘要映射到这里。 */
export interface LobbyRoomView {
  roomId: string;
  name: string;
  hasPassword: boolean;
  /** 是否已开局；大厅只区分等待中与游戏中两态。 */
  inGame: boolean;
  allowSpectators: boolean;
  playerCount: number;
  /** 上游不提供旁观人数时为 null，此时不显示该数字，不伪造为 0。 */
  spectatorCount: number | null;
  /** 房名后的来源标记，例如 CCB 的原版房。 */
  tag?: string;
}

const COUNT = "inline-block w-[2ch] text-right tabular-nums";

/**
 * 房间卡片的内容网格，真实卡片与骨架屏共用，两者尺寸因此一致。
 * 窄屏分三行：房名；房号与人数；分隔线下的阶段与观战。`sm` 起并成一行：房名与房号在左，阶段与人数在右。
 * 徽章与人数不换行，空间不足时只截断房名。
 */
export function RoomCardLayout({
  name,
  id,
  badges,
  counts,
  className,
}: {
  name: ReactNode;
  id: ReactNode;
  badges: ReactNode;
  counts: ReactNode;
  className?: string;
}) {
  return (
    <CardContent className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:px-5 sm:py-4", className)}>
      <div className="col-span-full row-1 flex min-w-0 items-center gap-2 truncate text-base font-medium sm:col-1">{name}</div>
      <div className="col-1 row-2 mt-0.5 text-sm text-muted-foreground sm:mt-1">{id}</div>
      <div className="col-span-full row-3 mt-3 flex items-center gap-2 border-t border-border/30 pt-2.5 sm:col-2 sm:row-[1/span_2] sm:mt-0 sm:border-0 sm:pt-0">
        {badges}
      </div>
      <div className="col-2 row-2 mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground tabular-nums sm:col-3 sm:row-[1/span_2] sm:mt-0 sm:text-sm">
        {counts}
      </div>
    </CardContent>
  );
}

/**
 * 大厅房间卡片：整张卡片可点，房名与房号在左，阶段、观战与人数在右。
 * 卡片自身是不透明实底，宿主页面滚动时不会透出下层内容。
 */
export function RoomListCard({
  room,
  onSelect,
  disabled = false,
}: {
  room: LobbyRoomView;
  onSelect: (event: React.MouseEvent<HTMLElement>) => void;
  disabled?: boolean;
}) {
  return (
    <motion.div
      variants={listItem}
      initial="initial"
      animate="animate"
      exit="exit"
      layout="position"
      className="rounded-md bg-card"
      {...selectable}
      // 卡片自身才是聚焦点。外层只承载按压与进出场动画，若不给 tabIndex，
      // framer-motion 会因为 whileTap 自动补上 tabIndex=0，把这里变成多出来的焦点停靠点。
      tabIndex={-1}
    >
      <Card
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        className={cn(
          "cursor-pointer transition-[background,border-color,box-shadow] duration-150 hover:border-primary/40 hover:bg-accent/40 hover:shadow-sm",
          disabled && "pointer-events-none opacity-60",
        )}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(event as unknown as React.MouseEvent<HTMLElement>);
          }
        }}
      >
        <RoomCardLayout
          name={
            <>
              <span className="truncate">{room.name}</span>
              {room.hasPassword ? <Lock aria-label="需要密码" className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
              {room.tag ? (
                <Badge variant="subtle" className="shrink-0">
                  {room.tag}
                </Badge>
              ) : null}
            </>
          }
          id={
            <>
              房间号: <span className="font-mono">{room.roomId}</span>
            </>
          }
          badges={
            <>
              <Badge variant={room.inGame ? "active" : "subtle"}>
                {room.inGame ? "游戏中" : "等待中"}
              </Badge>
              {room.allowSpectators ? (
                <Badge variant="subtle">
                  <Eye className="h-3.5 w-3.5" />
                  可观战
                </Badge>
              ) : (
                <Badge variant="unavailable">
                  <EyeOff className="h-3.5 w-3.5" />
                  禁观战
                </Badge>
              )}
            </>
          }
          counts={
            <>
              <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex items-center gap-2">
                <span><span className={COUNT}>{room.playerCount}</span>玩家</span>
                {room.spectatorCount !== null ? <span><span className={COUNT}>{room.spectatorCount}</span>旁观</span> : null}
              </span>
            </>
          }
        />
      </Card>
    </motion.div>
  );
}
