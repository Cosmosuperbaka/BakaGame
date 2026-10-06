import type { ReactNode, Ref } from "react";
import { motion } from "framer-motion";
import { Eye, EyeOff, Lock, Users } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card, CardContent } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { useSharedElementName } from "@/hooks/UsePageTransition";
import { listItem, listItemExit, selectable } from "@/lib/Motion";
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

/**
 * 房间卡片的内容网格，真实卡片与骨架屏共用，两者尺寸因此一致。
 * 窄屏分三行：房名；房号与人数；分隔线下的阶段与旁观。`sm` 起并成一行：房名与房号在左，阶段与人数在右。
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
      <div className="col-span-full row-3 mt-3 flex items-center gap-2 border-t border-border pt-2.5 sm:col-2 sm:row-[1/span_2] sm:mt-0 sm:border-0 sm:pt-0">
        {badges}
      </div>
      <div className="col-2 row-2 mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground tabular-nums sm:col-3 sm:row-[1/span_2] sm:mt-0 sm:text-sm">
        {counts}
      </div>
    </CardContent>
  );
}

/**
 * 大厅房间卡片：整张卡片可点，房名与房号在左，阶段、旁观与人数在右。
 * 卡片自身是不透明实底，宿主页面滚动时不会透出下层内容。
 * 入场只带 `listItem` 变体、不自带 initial/animate：起止由父级 `listContainer` 统一下发，各卡按序错峰。
 */
export function RoomListCard({
  room,
  roomPath,
  onSelect,
  disabled = false,
  pending = false,
  ref,
}: {
  room: LobbyRoomView;
  /** 该房间的页面路径：房名与房间顶栏的房名是同一个跨页共享元素，只在与该房间互相过渡时命名 */
  roomPath?: string;
  onSelect: (event: React.MouseEvent<HTMLElement>) => void;
  disabled?: boolean;
  /** 正在进入这间房：房名后转圈，其余卡片照常禁用 */
  pending?: boolean;
  /** 列表的 `AnimatePresence mode="popLayout"` 靠它把退场卡片抽出文档流 */
  ref?: Ref<HTMLDivElement>;
}) {
  const titleName = useSharedElementName("room-title", roomPath ?? false);
  // 被点的卡片保持原样（只多一枚转圈），其余卡片随在途操作变淡。
  const dimmed = disabled && !pending;
  return (
    <motion.div
      ref={ref}
      variants={listItem}
      // exit 写成对象而不是标签：任一变体标签都会让卡片自成一级、不再继承父级的 initial/animate 与错峰。
      exit={listItemExit}
      layout="position"
      className="rounded-md bg-card"
      // 禁用时不挂手势：不可点的卡片不该随指针缩放。
      {...(disabled ? undefined : selectable)}
      // 卡片自身才是聚焦点。外层只承载按压与进出场动画，若不给 tabIndex，
      // framer-motion 会因为 whileTap 自动补上 tabIndex=0，把这里变成多出来的焦点停靠点。
      tabIndex={-1}
    >
      <Card
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        aria-busy={pending || undefined}
        className={cn(
          "cursor-pointer transition-colors hover:border-primary/40 hover:bg-accent/40",
          disabled && "pointer-events-none",
          dimmed && "opacity-60",
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
              <span className="truncate" style={{ viewTransitionName: titleName }}>{room.name}</span>
              {room.hasPassword ? <Lock aria-label="需要密码" className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
              {room.tag ? (
                <Badge variant="subtle" size="xs" className="shrink-0">
                  {room.tag}
                </Badge>
              ) : null}
              {/* 进房在途：转圈接在房名行末，房名本就留有截断余地，不推动整张卡片或整列。 */}
              {pending ? (
                <span role="status" className="flex shrink-0 items-center text-muted-foreground">
                  <Spinner className="size-4" />
                  <span className="sr-only">正在进入房间</span>
                </span>
              ) : null}
            </>
          }
          id={
            <>
              房间号 <span className="font-mono">{room.roomId}</span>
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
                  可旁观
                </Badge>
              ) : (
                <Badge variant="unavailable">
                  <EyeOff className="h-3.5 w-3.5" />
                  禁止旁观
                </Badge>
              )}
            </>
          }
          counts={
            <>
              <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="tabular-nums">
                {room.playerCount} 人
                {room.spectatorCount !== null ? <> · {room.spectatorCount} 旁观</> : null}
              </span>
            </>
          }
        />
      </Card>
    </motion.div>
  );
}
