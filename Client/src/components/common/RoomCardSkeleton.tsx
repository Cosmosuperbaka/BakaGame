import { Card, CardContent } from "@/components/ui/Card";

export function RoomCardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="正在加载房间列表">
      {Array.from({ length: count }).map((_, index) => (
        <Card
          key={index}
          className="border-border/60 bg-card/40 pointer-events-none"
        >
          <CardContent className="p-4 sm:py-4 sm:px-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 animate-pulse">
            <div className="flex items-center gap-4 min-w-0">
              <div className="min-w-0 space-y-2">
                <div className="h-5 w-36 rounded bg-muted/70" />
                <div className="h-4 w-24 rounded bg-muted/40" />
              </div>
            </div>

            <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4 shrink-0 border-t border-border/30 pt-2.5 sm:border-0 sm:pt-0">
              <div className="flex items-center gap-2">
                <div className="h-5 w-12 rounded-full bg-muted/60" />
                <div className="h-5 w-14 rounded-full bg-muted/50" />
              </div>
              <div className="h-4 w-20 rounded bg-muted/50" />
            </div>
          </CardContent>
        </Card>
      ))}
      <span className="sr-only">正在加载房间列表...</span>
    </div>
  );
}
