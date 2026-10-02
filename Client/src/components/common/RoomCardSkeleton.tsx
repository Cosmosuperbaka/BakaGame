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
        <Card key={index} className="pointer-events-none">
          <RoomCardLayout
            // CSS 关键帧不受 MotionConfig 约束，减弱动效时由 motion-safe 关掉（Animation §3.6）。
            className="motion-safe:animate-pulse"
            // 骨架条用前景色低透明度：暗色的 muted 比 card 更暗，用 muted 会整片消失。
            name={<SkeletonLine className="w-36 bg-foreground/10" />}
            id={<SkeletonLine className="w-24 bg-foreground/6" />}
            badges={
              <>
                <Badge variant="placeholder"><span className="h-[1lh] w-[3em]" /></Badge>
                <Badge variant="placeholder"><span className="h-[1lh] w-[4.5em]" /></Badge>
              </>
            }
            counts={<SkeletonLine className="w-20 bg-foreground/8" />}
          />
        </Card>
      ))}
      <span className="sr-only">正在加载房间列表...</span>
    </div>
  );
}
