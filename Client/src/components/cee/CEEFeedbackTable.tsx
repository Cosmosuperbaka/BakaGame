import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useId, useLayoutEffect, useRef, useState, type Ref } from "react";
import { Check, Lightbulb } from "lucide-react";
import type { CEEFeedback, CEEFeedbackValue, CEEGuess } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Collapsible, DisclosureChevron } from "@/components/ui/Collapsible";
import { Hint } from "@/components/ui/Tooltip";
import { useMeasuredHeight } from "@/hooks/UseMeasuredHeight";
import {
  clueFlip,
  clueFlipChip,
  clueFlipFade,
  clueFlipName,
  clueFlipRow,
  listContainer,
  listItem,
  skeletonFade,
  spring,
} from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { CEECharacterImage } from "./CEECharacterImage";
import { CEE_COMPARISON, CEE_TONE_CLASS } from "./CEEComparison";

const GENDER_TEXT: Record<string, string> = { female: "女", male: "男" };

type NumericField = Exclude<
  keyof CEEFeedback,
  "sharedAppearances" | "tags" | "extraTags" | "gender"
>;
const FIELD_LABEL: Record<NumericField | "gender", string> = {
  gender: "性别",
  popularity: "人气",
  appearancesCount: "作品数",
  rating: "最高分",
  latestAppearance: "最晚登场",
  earliestAppearance: "最早登场",
};

/**
 * 一格数值：值与指向答案的箭头同处一个色块；成对的字段上下叠放，读屏先报字段名再报值。
 * `flip` 只在新到的那一行上打开：色块挂 `clueFlipChip`，跟着行的错峰逐格翻开。
 */
function ValueChip({
  field,
  data,
  flip = false,
}: {
  field: NumericField | "gender";
  data: CEEFeedbackValue;
  flip?: boolean;
}) {
  const { label, icon: Icon, tone } = CEE_COMPARISON[data.comparison];
  const missing = data.value === "" || data.value === "?" || data.value === -1;
  const text = missing
    ? "未知"
    : field === "gender"
      ? (GENDER_TEXT[String(data.value)] ?? "未知")
      : data.value;
  // 字段名只在读屏里出现，视觉上只剩数值与箭头；悬停补上「字段名：判定」，与读屏口径一致。
  return (
    <Hint label={`${FIELD_LABEL[field]}：${label}`}>
      <motion.span
        variants={flip ? clueFlipChip : undefined}
        className={cn(
          "inline-flex h-7 min-w-14 items-center justify-center gap-0.5 rounded-md border px-1.5 tabular-nums",
          CEE_TONE_CLASS[tone]
        )}
      >
        <span className="sr-only">{FIELD_LABEL[field]}</span>
        <span>{text}</span>
        <Icon className="size-3.5 shrink-0" role="img" aria-label={label} />
      </motion.span>
    </Hint>
  );
}

/**
 * 一次猜测的关键判定（性别 / 人气 / 作品数 / 最高分），与反馈表同款芯片。
 * 回放逐步重演时用它保持同一套视觉与读屏口径。
 */
export function CEEFeedbackChips({ feedback }: { feedback: CEEFeedback }) {
  return (
    <div className="flex flex-wrap gap-1">
      <ValueChip field="gender" data={feedback.gender} />
      <ValueChip field="popularity" data={feedback.popularity} />
      <ValueChip field="appearancesCount" data={feedback.appearancesCount} />
      <ValueChip field="rating" data={feedback.rating} />
    </div>
  );
}

function ValueCell({
  feedback,
  fields,
  flip,
}: {
  feedback: CEEFeedback;
  fields: Array<NumericField | "gender">;
  flip: boolean;
}) {
  return (
    <td className="px-1 py-2 text-center whitespace-nowrap">
      <span className="inline-flex flex-col items-stretch gap-1">
        {fields.map((field) => (
          <ValueChip key={field} field={field} data={feedback[field]} flip={flip} />
        ))}
      </span>
    </td>
  );
}

// 角色列横向滚动时贴住左缘；底色须不透明，滚过的数值列才不会透出来。右缘一道细线把它与滚动区分开。
// 容器窄于 30rem 时收起头像、收窄角色列：再窄就放不下带头像的整行，横滚前先让出这块宽度。
/**
 * 共同作品：默认最多两行，书名多到放不下时行尾省略，第一行右上角的箭头展开全文、再点收起。
 * 只在两行确实放不下时出现箭头；展开后保留它用于收起。高度经 `useMeasuredHeight` 按 `spring.settle` 补间。
 */
function SharedAppearances({ subjects }: { subjects: CEEFeedback["sharedAppearances"] }) {
  const text = subjects
    .map((subject) => subject.nameCn || subject.name || `作品 ${subject.id}`)
    .join("、");
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const height = useMeasuredHeight(textRef);
  const id = useId();

  // 收起时量是否被截断；列宽随容器变化，宽度一变就重量。展开后不量，箭头留着用来收起。
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node || expanded) return;
    const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, text]);

  const toggleable = overflowing || expanded;
  return (
    <motion.div
      initial={false}
      animate={height === null ? undefined : { height }}
      transition={spring.settle}
      className="relative overflow-hidden"
    >
      <p
        ref={textRef}
        id={id}
        className={cn("text-xs text-success", !expanded && "line-clamp-2", toggleable && "pr-6")}
      >
        共同作品：{text}
      </p>
      {toggleable ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute top-0 right-0 h-5 w-5 text-success"
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={expanded ? "收起共同作品" : "展开共同作品"}
          onClick={() => setExpanded((open) => !open)}
        >
          <DisclosureChevron open={expanded} iconClassName="size-3.5" />
        </Button>
      ) : null}
    </motion.div>
  );
}

const pinned = "sticky left-0 shadow-[inset_-1px_0_0_var(--color-border)]";

/**
 * 一次猜测。`fresh` 是表格挂载之后才到的猜测：旧行照常 `layout="position"` 下推，
 * 这一行不整行推入，而是角色名滑入、数值块逐格翻开、标签列最后显影（`clueFlip`）。
 */
function GuessRow({
  guess,
  showRound,
  fresh,
}: {
  guess: CEEGuess;
  showRound: boolean;
  fresh: boolean;
}) {
  const { character, feedback } = guess;
  const subtitle = character.nameCn && character.nameCn !== character.name ? character.nameCn : "";
  return (
    <motion.tr
      variants={fresh ? clueFlipRow : listItem}
      custom={guess.correct}
      layout="position"
      transition={clueFlip.push}
      className="origin-left border-t align-middle"
    >
      <th
        scope="row"
        className={cn(
          pinned,
          "z-panel w-[6rem] min-w-[6rem] bg-panel py-2 pr-2 pl-3 text-left font-normal @[30rem]:w-[9rem] @[30rem]:min-w-[9rem]",
          guess.correct &&
            "shadow-[inset_3px_0_0_var(--color-success),inset_-1px_0_0_var(--color-border)]"
        )}
      >
        <motion.span
          variants={fresh ? clueFlipName : undefined}
          className="flex items-center gap-2"
        >
          <CEECharacterImage character={character} className="hidden h-10 w-8 @[30rem]:flex" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className="block leading-snug font-medium">
              {character.name || character.nameCn}
            </span>
            {subtitle ? (
              <span className="block text-xs text-muted-foreground">{subtitle}</span>
            ) : null}
            <span className="mt-0.5 flex flex-wrap items-center gap-x-1 text-2xs text-muted-foreground">
              <span>{guess.playerName}</span>
              {showRound ? (
                <span className="whitespace-nowrap">· 第 {guess.syncRound} 轮</span>
              ) : null}
              {guess.correct ? (
                <span className="inline-flex items-center gap-0.5 text-success">
                  <Check className="size-3" aria-hidden="true" />
                  猜中
                </span>
              ) : guess.partial ? (
                <span className="inline-flex items-center gap-0.5 text-warning">
                  <Lightbulb className="size-3" aria-hidden="true" />
                  作品命中
                </span>
              ) : null}
            </span>
          </span>
        </motion.span>
      </th>
      <ValueCell feedback={feedback} fields={["gender", "popularity"]} flip={fresh} />
      <ValueCell feedback={feedback} fields={["appearancesCount", "rating"]} flip={fresh} />
      <ValueCell
        feedback={feedback}
        fields={["latestAppearance", "earliestAppearance"]}
        flip={fresh}
      />
      <td className="py-2 pr-3 pl-2">
        {/* 共同作品并入标签列首行：1440 宽房间页的游戏区不足 600px，单独成列会把整表顶出横滚。
            容器窄于 26rem 时整表无论如何都要横滚，标签列取「容器宽 − 角色列 6rem − 本格内边距 1.25rem」：
            滚到最右时恰好填满角色列右侧的可视区，不被贴边的角色列遮住开头，行也更矮。 */}
        <motion.div
          variants={fresh ? clueFlipFade : undefined}
          className="min-w-[calc(100cqw-7.25rem)] space-y-1.5 @[26rem]:min-w-[7rem]"
        >
          {feedback.sharedAppearances.length ? (
            <SharedAppearances subjects={feedback.sharedAppearances} />
          ) : null}
          {feedback.tags.length ? (
            <div className="flex flex-wrap gap-1">
              {/* 徽章正文（标签名或「已隐藏」）与配色已说清状态，不再挂 hover 复述一遍 */}
              {feedback.tags.map((tag, index) => (
                <Badge
                  key={`${tag.kind}:${index}`}
                  size="sm"
                  variant={tag.matched && !tag.hidden ? "matched" : "muted"}
                >
                  {tag.hidden ? "已隐藏" : tag.text}
                </Badge>
              ))}
            </div>
          ) : !feedback.sharedAppearances.length ? (
            <span className="text-muted-foreground">—</span>
          ) : null}
          {feedback.extraTags.length ? (
            <Collapsible title="游戏专属标签" size="sm">
              <div className="space-y-2 text-xs">
                {feedback.extraTags.map((group) => (
                  <section key={group.section} className="space-y-1">
                    <h4 className="font-medium">{group.section}</h4>
                    <div className="flex flex-wrap gap-1">
                      {group.tags.map((tag) => (
                        <Badge key={tag.text} size="sm" variant={tag.matched ? "matched" : "muted"}>
                          {tag.text}
                          {tag.matched ? (
                            <Check className="size-3" role="img" aria-label="匹配" />
                          ) : null}
                        </Badge>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </Collapsible>
          ) : null}
        </motion.div>
      </td>
    </motion.tr>
  );
}

/** 表头两行：成对的字段上下叠放，与单元格内的两块色块逐一对应。 */
const HEADERS: Array<{ key: string; lines: string[]; name?: string }> = [
  { key: "profile", lines: ["性别", "人气"], name: "性别与人气" },
  { key: "works", lines: ["作品数", "最高分"], name: "作品数与最高分" },
  { key: "years", lines: ["最晚登场", "最早登场"], name: "最晚与最早登场" },
  { key: "tags", lines: ["标签"] },
];

/**
 * 猜测反馈：一次猜测一行，最新的在最上面，紧挨搜索框。
 * 角色列贴住左缘，窄屏横向滚动时只移动数值与标签。
 */
export function CEEFeedbackTable({
  guesses,
  showRound = false,
}: {
  guesses: CEEGuess[];
  showRound?: boolean;
}) {
  const rows = [...guesses].reverse();
  // 挂载时已有的猜测（进房、重连、换阶段）照常整行推入；之后才到的才逐格翻开。减弱动效下一律不翻。
  const reducedMotion = useReducedMotion();
  const [seenAtMount] = useState(() => new Set(guesses.map((guess) => guess.id)));
  const isFresh = (guess: CEEGuess) => !reducedMotion && !seenAtMount.has(guess.id);
  // 空状态与表格叠在同一格：第一条猜测到达时空状态原地淡出、表格行推上来，两者交叉而不是先清空再出现。
  return (
    <div className="relative grid">
      <AnimatePresence initial={false} mode="popLayout">
        {rows.length ? (
          <FeedbackRows key="rows" rows={rows} showRound={showRound} isFresh={isFresh} />
        ) : (
          <motion.p
            key="empty"
            exit={skeletonFade.exit}
            className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground [grid-area:1/1]"
          >
            提交第一个猜测后，这里会显示线索
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

function FeedbackRows({
  ref,
  rows,
  showRound,
  isFresh,
}: {
  ref?: Ref<HTMLDivElement>;
  rows: CEEGuess[];
  showRound: boolean;
  isFresh: (guess: CEEGuess) => boolean;
}) {
  return (
    <div
      ref={ref}
      className="@container overflow-x-auto rounded-md border bg-panel [grid-area:1/1]"
      tabIndex={0}
      role="region"
      aria-label="猜测反馈"
    >
      <table className="w-full text-sm">
        <thead className="bg-muted text-xs text-muted-foreground">
          <tr>
            <th
              scope="col"
              className={cn(pinned, "z-sticky bg-muted py-2 pr-2 pl-3 text-left font-medium")}
            >
              角色
            </th>
            {HEADERS.map((header) => (
              <th
                key={header.key}
                scope="col"
                aria-label={header.name}
                className={cn(
                  "px-1 py-2 font-medium whitespace-nowrap last:pr-3",
                  header.key === "tags" ? "px-2 text-left" : "text-center"
                )}
              >
                {header.lines.map((line) => (
                  <span key={line} className="block leading-tight">
                    {line}
                  </span>
                ))}
              </th>
            ))}
          </tr>
        </thead>
        <motion.tbody variants={listContainer(rows.length)} initial="initial" animate="animate">
          {rows.map((guess) => (
            <GuessRow key={guess.id} guess={guess} showRound={showRound} fresh={isFresh(guess)} />
          ))}
        </motion.tbody>
      </table>
    </div>
  );
}
