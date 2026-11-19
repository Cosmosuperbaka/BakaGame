import { AnimatePresence, motion } from "framer-motion";
import { AtSign } from "lucide-react";
import { optionTappable } from "@/lib/motion/Feedback";
import { popover } from "@/lib/motion/Choreography";
import { cn } from "@/lib/Utils";
import type { ChatMentionPlayer } from "@/components/common/chat/ChatMessage";

/**
 * 提及候选列表，自输入框上缘展开。输入框才是组合框、焦点留在它那里：
 * 候选只经 `aria-activedescendant` 指向，不进 Tab 序列；`listId` 与 `optionId` 由输入框一侧给出以便互相关联。
 */
export function MentionList({
  candidates,
  activeIndex,
  listId,
  optionId,
  onPick,
  onHover,
}: {
  candidates: ChatMentionPlayer[];
  activeIndex: number;
  listId: string;
  optionId: (index: number) => string;
  onPick: (name: string) => void;
  onHover: (index: number) => void;
}) {
  return (
    <AnimatePresence>
      {candidates.length > 0 && (
        <motion.div
          variants={popover}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{ originY: 1 }}
          id={listId}
          // 点候选不能先让输入框失焦：失焦会把候选收起，点击就落空。
          onMouseDown={(event) => event.preventDefault()}
          role="listbox"
          aria-label="提及玩家"
          className="absolute bottom-full left-3 right-3 z-dropdown mb-1 overflow-hidden floating-surface shadow-md"
        >
          {candidates.map((player, index) => (
            <motion.button
              key={player.id}
              id={optionId(index)}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              // 焦点留在输入框里，候选只经 aria-activedescendant 指向，不进 Tab 序列。
              tabIndex={-1}
              {...optionTappable}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(player.name)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                "border-t first:border-t-0",
                index === activeIndex
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <AtSign className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{player.name}</span>
            </motion.button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
