import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock3,
  Equal,
  Flag,
  Minus,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { Hint } from "@/components/ui/Tooltip";
import { listItem } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import type { SongGuessAttempt, SongGuessDirection } from "@bakagame/shared";

/** 方向箭头指向答案：higher 即答案比这次猜的更大（年份更晚、热度更高）。 */
const DIRECTION_ICON: Record<SongGuessDirection, LucideIcon> = {
  higher: ArrowUp,
  lower: ArrowDown,
  equal: Equal,
  unknown: Minus,
};
const YEAR_HINT: Record<SongGuessDirection, string> = {
  higher: "答案更晚",
  lower: "答案更早",
  equal: "年份相同",
  unknown: "无法比较",
};
const POPULARITY_HINT: Record<SongGuessDirection, string> = {
  higher: "答案热度更高",
  lower: "答案热度更低",
  equal: "热度相同",
  unknown: "无法比较",
};

/**
 * 一枚反馈徽章：取值与指向答案的图标同处一枚，命中（相同）用 `matched`，其余 `muted`。
 * 图标对读屏隐藏，含义由紧随其后的视觉隐藏文字读出，鼠标悬停时浮层给出同一句。
 */
function FeedbackBadge({
  matched,
  icon: Icon,
  hint,
  children,
}: {
  matched: boolean;
  icon: LucideIcon;
  hint: string;
  children: ReactNode;
}) {
  return (
    <Hint label={hint}>
      <Badge variant={matched ? "matched" : "muted"} size="sm" className="tabular-nums">
        {children}
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">，{hint}</span>
      </Badge>
    </Hint>
  );
}

/** 每条猜测的结果图标；可读名挂在图标上（`role="img"`），不另占一段文字。 */
const RESULT_MARK: Record<
  SongGuessAttempt["result"],
  { icon: LucideIcon; tone: string; label: string }
> = {
  correct: { icon: Check, tone: "text-success", label: "猜对" },
  timeout: { icon: Clock3, tone: "text-warning", label: "超时" },
  gaveUp: { icon: Flag, tone: "text-muted-foreground", label: "投降" },
  wrong: { icon: X, tone: "text-destructive", label: "猜错" },
};

function attemptText(attempt: SongGuessAttempt) {
  if (attempt.guessedAnime) return attempt.guessedAnime.nameCn || attempt.guessedAnime.name;
  if (attempt.guessedSong) return `${attempt.guessedSong.title} · ${attempt.guessedSong.artist}`;
  return attempt.result === "gaveUp" ? "投降" : "超时";
}

function AttemptFeedback({ feedback }: { feedback: NonNullable<SongGuessAttempt["feedback"]> }) {
  const year = feedback.releaseYearDirection;
  const popularity = feedback.popularityDirection;
  return (
    <div className="flex flex-wrap gap-1">
      <FeedbackBadge matched={year === "equal"} icon={DIRECTION_ICON[year]} hint={YEAR_HINT[year]}>
        年份 {feedback.releaseYear ?? "未知"}
      </FeedbackBadge>
      <FeedbackBadge
        matched={popularity === "equal"}
        icon={DIRECTION_ICON[popularity]}
        hint={POPULARITY_HINT[popularity]}
      >
        热度 {feedback.popularity ?? "未知"}
      </FeedbackBadge>
      {feedback.languageMatch !== undefined ? (
        <FeedbackBadge
          matched={feedback.languageMatch}
          icon={feedback.languageMatch ? Check : X}
          hint={feedback.languageMatch ? "语种相同" : "语种不同"}
        >
          语种
        </FeedbackBadge>
      ) : null}
      {/* 共同标签本身就是与答案重合的线索 */}
      {feedback.sharedTags.map((tag) => (
        <Badge key={tag} variant="matched" size="sm">
          {tag}
        </Badge>
      ))}
    </div>
  );
}

/**
 * 猜测记录。名字在上、反馈徽章在下，名字不和徽章抢宽度，窄屏不会被挤成逐字竖排。
 * 从无到有时整块按 collapsible 撑开；之后新提交的一行以 listItem 推入，其余行按位置让开。
 */
export function AttemptList({
  attempts,
  title,
  showPlayerName = false,
}: {
  attempts: SongGuessAttempt[];
  title: string;
  showPlayerName?: boolean;
}) {
  return (
    // 外层常驻：所在 space-y 容器的间距不随有无记录跳一下，收放只交给 CollapsibleRegion。
    <div>
      <CollapsibleRegion open={attempts.length > 0}>
        <section className="overflow-hidden rounded-md border bg-panel">
          <div className="bg-muted px-4 py-2.5">
            <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
          </div>
          <AnimatePresence initial={false}>
            {attempts.map((attempt) => {
              const mark = RESULT_MARK[attempt.result];
              return (
                <motion.div
                  key={attempt.id}
                  variants={listItem}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  layout="position"
                  className="flex origin-left flex-col gap-1.5 border-t px-4 py-3"
                >
                  <div className="flex min-w-24 items-center gap-2">
                    <mark.icon
                      role="img"
                      aria-label={mark.label}
                      className={cn("h-4 w-4 shrink-0", mark.tone)}
                    />
                    <span className="min-w-0 break-words text-sm">
                      {showPlayerName ? `${attempt.playerName}：` : ""}
                      {attemptText(attempt)}
                    </span>
                  </div>
                  {/* 徽章行与名字左缘对齐（让过 h-4 图标与 gap-2） */}
                  {attempt.feedback ? (
                    <div className="pl-6">
                      <AttemptFeedback feedback={attempt.feedback} />
                    </div>
                  ) : null}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </section>
      </CollapsibleRegion>
    </div>
  );
}
