import { useMemo } from "react";

import { ccbCompareArrow, ccbCompareTone, type CCBScalarDisplay, type CCBTone } from "@/lib/CCBFeedback";
import { cn } from "@/lib/Utils";
import type { CCBCompareFeedback, CCBFeedback, CCBGender, CCBGuessRecord } from "@/types";

const TONE_CLASS: Record<CCBTone, string> = {
  correct: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  partial: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  unknown: "bg-muted text-muted-foreground",
  neutral: "",
};

const GENDER_LABEL: Record<CCBGender, string> = {
  male: "男",
  female: "女",
  "?": "?",
};

const Cell = ({
  tone = "neutral",
  children,
  className,
}: {
  tone?: CCBTone;
  children: React.ReactNode;
  className?: string;
}) => (
  <td className={cn("whitespace-nowrap px-2 py-1.5 text-center", className)}>
    <span
      className={cn("inline-flex min-w-8 justify-center rounded-md px-1.5 py-0.5", TONE_CLASS[tone])}
    >
      {children}
    </span>
  </td>
);

/** 数值 + 箭头。箭头只由档位决定（`+*` → `↓`、`-*` → `↑`）。 */
const ScalarValue = ({
  value,
  feedback,
}: {
  value: CCBScalarDisplay;
  feedback: CCBCompareFeedback;
}) => {
  const arrow = ccbCompareArrow(feedback);
  return (
    <>
      {value}
      {arrow ? (
        <span aria-hidden className="ml-0.5 opacity-80">
          {arrow}
        </span>
      ) : null}
    </>
  );
};

/** 共同作品：优先中文名，缺失回落原名；多个时按原版补 ` +N`。 */
const sharedLabel = (shared: CCBFeedback["shared_appearances"]): string => {
  if (shared.count <= 0) return "—";
  const name = shared.firstCn || shared.firstOriginal || shared.first;
  return shared.count > 1 ? `${name} +${shared.count - 1}` : name;
};

interface GuessTableProps {
  guesses: CCBGuessRecord[];
  className?: string;
}

/**
 * 猜测表：每行一次猜测，逐字段展示反馈档位与箭头。
 *
 * 列与原版对齐：性别 / 热度 / 最高分 / 作品数 / 最新 / 最早 / 共同作品 / 标签。
 */
export function GuessTable({ guesses, className }: GuessTableProps) {
  // 新的在上：玩家最关心最近一次。
  const rows = useMemo(() => [...guesses].reverse(), [guesses]);

  if (rows.length === 0) {
    return (
      <p className={cn("px-3 py-6 text-center text-sm text-muted-foreground", className)}>
        还没有猜测记录
      </p>
    );
  }

  return (
    <div className={cn("scrollbar-hidden min-h-0 overflow-auto", className)}>
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-card text-muted-foreground">
          <tr className="border-b border-border/70">
            <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">角色</th>
            <th className="px-2 py-1.5 font-medium">性别</th>
            <th className="px-2 py-1.5 font-medium">热度</th>
            <th className="px-2 py-1.5 font-medium">最高分</th>
            <th className="px-2 py-1.5 font-medium">作品数</th>
            <th className="px-2 py-1.5 font-medium">最新</th>
            <th className="px-2 py-1.5 font-medium">最早</th>
            <th className="px-2 py-1.5 font-medium">共同作品</th>
            <th className="px-2 py-1.5 text-left font-medium">标签</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((guess, index) => {
            const { feedback } = guess;
            const sharedTags = new Set(feedback.metaTags.shared);
            return (
              <tr
                key={`${guess.characterId}-${guess.submittedAt}-${index}`}
                className={cn(
                  "border-b border-border/50 last:border-0",
                  guess.correct && "bg-emerald-500/8",
                )}
              >
                <td className="max-w-40 truncate px-2 py-1.5" title={guess.characterName}>
                  <span className="font-medium">
                    {guess.characterNameCn || guess.characterName}
                  </span>
                  {guess.correct ? <span className="ml-1">✔</span> : null}
                </td>
                <Cell tone={feedback.gender.feedback === "yes" ? "correct" : "neutral"}>
                  {GENDER_LABEL[feedback.gender.guess]}
                </Cell>
                <Cell tone={ccbCompareTone(feedback.popularity.feedback)}>
                  <ScalarValue
                    value={feedback.popularity.guess}
                    feedback={feedback.popularity.feedback}
                  />
                </Cell>
                <Cell tone={ccbCompareTone(feedback.rating.feedback)}>
                  <ScalarValue
                    value={feedback.rating.guess === -1 ? "无" : feedback.rating.guess}
                    feedback={feedback.rating.feedback}
                  />
                </Cell>
                <Cell tone={ccbCompareTone(feedback.appearancesCount.feedback)}>
                  <ScalarValue
                    value={feedback.appearancesCount.guess}
                    feedback={feedback.appearancesCount.feedback}
                  />
                </Cell>
                <Cell tone={ccbCompareTone(feedback.latestAppearance.feedback)}>
                  <ScalarValue
                    value={feedback.latestAppearance.guess}
                    feedback={feedback.latestAppearance.feedback}
                  />
                </Cell>
                <Cell tone={ccbCompareTone(feedback.earliestAppearance.feedback)}>
                  <ScalarValue
                    value={feedback.earliestAppearance.guess}
                    feedback={feedback.earliestAppearance.feedback}
                  />
                </Cell>
                <Cell tone={feedback.shared_appearances.count > 0 ? "correct" : "neutral"}>
                  <span
                    className="max-w-44 truncate"
                    title={sharedLabel(feedback.shared_appearances)}
                  >
                    {sharedLabel(feedback.shared_appearances)}
                  </span>
                </Cell>
                <td className="px-2 py-1.5">
                  <div className="flex max-w-64 flex-wrap gap-1">
                    {feedback.metaTags.guess.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      feedback.metaTags.guess.map((tag, tagIndex) => (
                        <span
                          // 被遮掩的标签都是 `???`，必须带下标才唯一。
                          key={`${tag}-${tagIndex}`}
                          className={cn(
                            "rounded border px-1 py-px text-[10px]",
                            sharedTags.has(tag)
                              ? "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                              : "border-border/70 text-muted-foreground",
                          )}
                        >
                          {tag}
                        </span>
                      ))
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
