import { Spinner } from "@/components/ui/Spinner";

/**
 * 等待页在套用上次房间设置期间的占位：设置面板等恢复落定后再挂载，
 * 面板的草稿才会从恢复后的快照起步，而不是停在旧值、再被一次编辑盖回服务端。
 */
export function RoomRestoreFallback() {
  return (
    <div
      role="status"
      aria-label="正在恢复上次的房间设置"
      className="mx-auto flex min-h-[50vh] w-full max-w-md items-center justify-center"
    >
      <Spinner className="size-6 text-primary" />
    </div>
  );
}
