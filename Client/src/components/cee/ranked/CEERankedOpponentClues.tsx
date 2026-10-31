import { AnimatePresence, motion } from "framer-motion";
import { Check, Lightbulb } from "lucide-react";
import type { CEEComparison, CEERankedMaskedGuess } from "@bakagame/shared";
import { Hint } from "@/components/ui/Tooltip";
import { listItem, skeletonFade } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { CEE_COMPARISON, CEE_TONE_CLASS } from "../CEEComparison";

type MaskedField = Exclude<
  keyof CEERankedMaskedGuess["feedback"],
  "sharedAppearance" | "tagMatched" | "tagTotal"
>;

/** 与反馈表同一列序：性别与人气、作品数与最高分、最晚与最早登场。 */
const FIELDS: Array<{ key: MaskedField; label: string; short: string }> = [
  { key: "gender", label: "性别", short: "性别" },
  { key: "popularity", label: "人气", short: "人气" },
  { key: "appearancesCount", label: "作品数", short: "作品" },
  { key: "rating", label: "最高分", short: "评分" },
  { key: "latestAppearance", label: "最晚登场", short: "最晚" },
  { key: "earliestAppearance", label: "最早登场", short: "最早" },
];

/** 一格只有方向与远近：图标代替数值，读屏报「字段：判定」。 */
function SignChip({
  field,
  comparison,
}: {
  field: (typeof FIELDS)[number];
  comparison: CEEComparison;
}) {
  const { label, icon: Icon, tone } = CEE_COMPARISON[comparison];
  return (
    <Hint label={`${field.label}：${label}`}>
      <span
        className={cn(
          "inline-flex size-6 items-center justify-center rounded-md border sm:size-7",
          CEE_TONE_CLASS[tone]
        )}
      >
        <Icon className="size-3.5" role="img" aria-label={`${field.label}：${label}`} />
      </span>
    </Hint>
  );
}

/** 标签只给命中个数：「命中 / 展示总数」，有命中时转绿，不出现任何标签文字。 */
function TagCount({ matched, total }: { matched: number; total: number }) {
  const label = `标签命中 ${matched} / ${total}`;
  return (
    <Hint label={label}>
      <span
        className={cn(
          "inline-flex h-6 min-w-10 items-center justify-center rounded-md border px-1 font-mono text-xs tabular-nums sm:h-7 sm:min-w-11 sm:px-1.5",
          matched > 0 ? CEE_TONE_CLASS.match : CEE_TONE_CLASS.far
        )}
        role="img"
        aria-label={label}
      >
        {matched}/{total}
      </span>
    </Hint>
  );
}

function ClueRow({ guess }: { guess: CEERankedMaskedGuess }) {
  const { feedback } = guess;
  return (
    <motion.li
      layout="position"
      variants={listItem}
      initial="initial"
      animate="animate"
      exit="exit"
      className={cn(
        "flex items-center gap-1 rounded-md border px-2 py-1.5 sm:gap-1.5",
        guess.correct ? "border-success/50 bg-success/5" : "bg-panel"
      )}
    >
      <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground tabular-nums sm:w-7">
        #{guess.index}
      </span>
      <span className="flex gap-1 sm:gap-1.5">
        {FIELDS.map((field) => (
          <SignChip key={field.key} field={field} comparison={feedback[field.key]} />
        ))}
      </span>
      <Hint label={feedback.sharedAppearance ? "命中共同作品" : "没有共同作品"}>
        <span
          className={cn(
            "inline-flex size-6 items-center justify-center rounded-md border sm:size-7",
            feedback.sharedAppearance ? CEE_TONE_CLASS.match : CEE_TONE_CLASS.far
          )}
        >
          <Lightbulb
            className="size-3.5"
            role="img"
            aria-label={feedback.sharedAppearance ? "命中共同作品" : "没有共同作品"}
          />
        </span>
      </Hint>
      <TagCount matched={feedback.tagMatched} total={feedback.tagTotal} />
      {guess.correct ? (
        <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-success">
          <Check className="size-3.5" aria-hidden="true" />
          猜中
        </span>
      ) : null}
    </motion.li>
  );
}

/**
 * 对手的线索：只看得到每次猜测的比较方向、远近、是否命中共同作品与标签命中个数，
 * 看不到猜了谁、具体数值与标签文字（服务端已脱敏，这里只是如实画出来）。
 * 最新的一次在最上面，与本人的反馈表同一读序；挂载时已有的行不再推入，之后推来的新行从左缘推到前面。
 */
export function CEERankedOpponentClues({
  guesses,
  attempts,
  allowance,
}: {
  guesses: CEERankedMaskedGuess[];
  attempts: number;
  allowance: number;
}) {
  const rows = [...guesses].reverse();
  return (
    <section aria-label="对手的线索" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-serif text-sm font-semibold">对手的线索</h3>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          已猜 {attempts} / {allowance}
        </span>
      </div>
      <div
        className="grid grid-cols-[1.5rem_repeat(7,1.5rem)_2.5rem] items-end gap-1 px-2 text-2xs text-muted-foreground sm:grid-cols-[1.75rem_repeat(7,1.75rem)_2.75rem] sm:gap-1.5"
        aria-hidden="true"
      >
        <span />
        {FIELDS.map((field) => (
          <span key={field.key} className="text-center">
            {field.short}
          </span>
        ))}
        <span className="text-center">同作</span>
        <span className="text-center">标签</span>
      </div>
      <div className="relative grid">
        <AnimatePresence initial={false} mode="popLayout">
          {rows.length ? (
            <motion.ol key="rows" className="space-y-1.5 [grid-area:1/1]" aria-live="polite">
              <AnimatePresence initial={false}>
                {rows.map((guess) => (
                  <ClueRow key={guess.index} guess={guess} />
                ))}
              </AnimatePresence>
            </motion.ol>
          ) : (
            <motion.p
              key="empty"
              exit={skeletonFade.exit}
              className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground [grid-area:1/1]"
            >
              对手还没有出手
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
