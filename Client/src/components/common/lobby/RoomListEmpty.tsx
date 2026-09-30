import { motion } from "framer-motion";
import { backdrop } from "@/lib/Motion";

/** 三游戏共用的大厅空状态。 */
export function RoomListEmpty() {
  return (
    <motion.div
      key="empty"
      variants={backdrop}
      initial="initial"
      animate="animate"
      exit="exit"
      className="flex flex-col items-center justify-center rounded-md border border-dashed border-border/80 bg-muted/40 py-16 text-center"
    >
      <p className="text-sm text-muted-foreground">暂无房间，点击上方按钮创建一个吧</p>
    </motion.div>
  );
}
