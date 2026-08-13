import { motion } from "framer-motion";
import { CircleSlash } from "lucide-react";
import { listItem, selectable } from "@/lib/motion";

export function AbstainOption({ onSelect }: { onSelect: () => void }) {
  return (
    <motion.button
      type="button"
      variants={listItem}
      {...selectable}
      className="col-span-2 flex cursor-pointer items-center justify-between rounded-md border border-dashed bg-transparent px-4 py-3.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      onClick={onSelect}
    >
      <span className="truncate text-sm font-medium">弃票</span>
      <CircleSlash className="ml-2 h-4 w-4 shrink-0" />
    </motion.button>
  );
}
