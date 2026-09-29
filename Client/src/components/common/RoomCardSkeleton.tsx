import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { RoomCardLayout } from "@/components/common/lobby/RoomListCard";
import { cn } from "@/lib/Utils";

/** 占一整行文字高度（随所在字号），条本身略矮于行高，与真实文字的视觉高度相近。 */
function SkeletonLine({ className }: { className: string }) {
  return (
    <span className="flex h-[1lh] items-center">
      <span className={cn("h-[0.8lh] rounded-md", className)} />
    </span>
  );
}

/** 房间卡片骨架：与真实卡片共用 `RoomCardLayout`，徽章位用 `placeholder` 变体，加载前后不跳动。 */
export function RoomCardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="正在加载房间列表">
      {Array.from({ length: count }).map((_, index) => (
        <Card key={index} className="pointer-events-none border-border/60 bg-card/40">
          <RoomCardLayout
            className="animate-pulse"
            name={<SkeletonLine className="w-36 bg-muted/70" />}
            id={<SkeletonLine className="w-24 bg-muted/40" />}
            badges={
              <>
                <Badge variant="placeholder"><span className="h-[1lh] w-[3em]" /></Badge>
                <Badge variant="placeholder"><span className="h-[1lh] w-[4.5em]" /></Badge>
              </>
            }
            counts={<SkeletonLine className="w-20 bg-muted/50" />}
          />
        </Card>
      ))}
      <span className="sr-only">正在加载房间列表...</span>
    </div>
  );
}
