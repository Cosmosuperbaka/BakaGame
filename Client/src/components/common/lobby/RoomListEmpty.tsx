import type { MouseEvent, Ref } from "react";
import { motion } from "framer-motion";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { RoomCardSkeleton } from "@/components/common/RoomCardSkeleton";
import { listItem, listItemExit } from "@/lib/Motion";

/**
 * 三游戏共用的大厅空状态：「暂无房间」与就地的创建入口（「创建第一个房间」）。
 * 与骨架屏同高：底下垫一份看不见的骨架撑开高度（各断点下卡片行数不同，写死高度对不齐），
 * 加载结束落到空列表时整块高度不变，下方内容不跳。
 */
export function RoomListEmpty({ onCreate, disabled = false, ref }: {
  /** 空状态里的「创建第一个房间」，与列表标题行的「创建房间」同一个回调；名字不同，读屏与查找时不会撞成两个同名按钮。不传时不显示按钮 */
  onCreate?: (event: MouseEvent<HTMLElement>) => void;
  disabled?: boolean;
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
        className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-muted/40 p-6 text-center [grid-area:1/1]"
      >
        <p className="text-sm text-muted-foreground">暂无房间</p>
        {onCreate ? (
          <Button variant="outline" size="sm" onClick={onCreate} disabled={disabled} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            创建第一个房间
          </Button>
        ) : null}
      </div>
    </motion.div>
  );
}
