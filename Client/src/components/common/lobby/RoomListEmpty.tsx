import type { Ref } from "react";
import { motion } from "framer-motion";
import { DoorOpen } from "lucide-react";
import { RoomCardSkeleton } from "@/components/common/RoomCardSkeleton";
import { listItem, listItemExit } from "@/lib/Motion";

/**
 * 三游戏共用的大厅空状态：「暂无房间」与一行指引。创建入口只有标题行的「创建房间」一个，空状态不再放第二个按钮。
 * 与骨架屏同高：底下垫一份看不见的骨架撑开高度（各断点下卡片行数不同，写死高度对不齐），
 * 加载结束落到空列表时整块高度不变，下方内容不跳。
 */
export function RoomListEmpty({ ref }: {
  /** 列表的 `AnimatePresence mode="popLayout"` 靠它把退场的空状态抽出文档流 */
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    // 与房间卡片同一种进出场：起止由父级 listContainer 下发，exit 写成对象以免自成一级。
    <motion.div ref={ref} variants={listItem} exit={listItemExit} className="grid grid-cols-1">
      <div aria-hidden="true" className="pointer-events-none invisible [grid-area:1/1]">
        <RoomCardSkeleton count={3} />
      </div>
      <div
        role="status"
        className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/40 p-6 text-center [grid-area:1/1]"
      >
        <DoorOpen className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm">暂无房间</p>
        <p className="text-xs text-muted-foreground">创建一个房间，把链接发给朋友就能一起玩</p>
      </div>
    </motion.div>
  );
}
