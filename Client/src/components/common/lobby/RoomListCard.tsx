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
 * 大厅房间卡片：整张卡片可点，房名与房号在左，阶段、观战与人数在右。
 * 卡片自身是不透明实底，宿主页面滚动时不会透出下层内容。
 */
export function RoomListCard({
  room,
  onSelect,
}: {
  room: LobbyRoomView;
  onSelect: (event: React.MouseEvent<HTMLElement>) => void;
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
    >
      <Card
        role="button"
        tabIndex={0}
        className="cursor-pointer transition-[background,border-color,box-shadow] duration-150 hover:border-primary/40 hover:bg-accent/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(event as unknown as React.MouseEvent<HTMLElement>);
          }
        }}
      >
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5 sm:py-4">
          <div className="flex min-w-0 items-center gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 truncate text-base font-medium">
                <span className="truncate">{room.name}</span>
                {room.hasPassword ? <Lock aria-label="需要密码" className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
                {room.tag ? (
                  <Badge variant="outline" className="shrink-0 border-border/80 text-xs font-normal text-muted-foreground">
                    {room.tag}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-0.5 text-sm text-muted-foreground sm:mt-1">
                房间号: <span className="font-mono">{room.roomId}</span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/30 pt-2.5 text-sm text-muted-foreground sm:justify-end sm:gap-4 sm:border-0 sm:pt-0">
            <div className="flex items-center gap-2">
              <Badge
                variant={room.inGame ? "secondary" : "outline"}
                className={cn(
                  "text-xs font-normal",
                  room.inGame
                    ? "border border-primary/20 bg-primary/10 text-primary"
                    : "border-border/80 text-muted-foreground",
                )}
              >
                {room.inGame ? "游戏中" : "等待中"}
              </Badge>
              {room.allowSpectators ? (
                <Badge variant="outline" className="gap-1 border-border/80 text-xs font-normal text-muted-foreground">
                  <Eye className="h-3.5 w-3.5" />
                  可观战
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 border-dashed border-border/60 text-xs font-normal text-muted-foreground/45">
                  <EyeOff className="h-3.5 w-3.5" />
                  禁观战
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground sm:text-sm">
              <Users className="h-4 w-4 shrink-0 text-muted-foreground/70" />
              <span className="flex items-center gap-2">
                <span><span className={COUNT}>{room.playerCount}</span>玩家</span>
                {room.spectatorCount !== null ? <span><span className={COUNT}>{room.spectatorCount}</span>旁观</span> : null}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
