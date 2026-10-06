import { motion } from "framer-motion";
import { CircleSlash } from "lucide-react";
import { listItem, selectable } from "@/lib/Motion";

/**
 * 放弃本次决定的选项：投票里是「弃票」，夜晚是「不行动」。
 * 与具体玩家并入同一组，占满整行、虚线描边，区别于实色块的玩家选项。
 */
export function AbstainOption({
  label,
  onSelect,
  disabled,
}: {
  label: string;
  onSelect: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
}) {
  return (
    <motion.button
      type="button"
      variants={listItem}
      {...selectable}
      className="col-span-2 flex cursor-pointer items-center justify-between rounded-md border border-dashed bg-transparent px-4 py-3.5 text-left text-muted-foreground transition-colors hover:bg-accent/40"
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="truncate text-sm font-medium">{label}</span>
      <CircleSlash className="ml-2 h-4 w-4 shrink-0" />
    </motion.button>
  );
}
