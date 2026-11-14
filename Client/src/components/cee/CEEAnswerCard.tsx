import { motion } from "framer-motion";
import type { CEECharacterView } from "@bakagame/shared";
import { CEEBangumiRichText } from "@/components/cee/CEEBangumiRichText";
import { Badge } from "@/components/ui/Badge";
import { ClampedText } from "@/components/ui/ClampedText";
import { revealCard } from "@/lib/motion/NamedMoves";
import { cn } from "@/lib/Utils";
import { CEECharacterImage } from "./CEECharacterImage";
import { CEE_GENDER_TEXT, CEE_UNKNOWN_NUMBER } from "./CEEComparison";

/**
 * 资料表的一行：窄屏字段名在上、内容占满整宽（并排时简介每行只剩六七个字，作品名也被截得只剩开头），
 * `sm` 起左列字段名、右列内容。
 */
const DETAIL_ROW = "flex flex-col gap-1 sm:flex-row sm:gap-3";
const DETAIL_LABEL = "shrink-0 text-xs text-muted-foreground sm:w-10 sm:text-sm";

/** 资料格：小号字段名在上、数值在下，几格并排成一行，窄屏自动折行。 */
function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * 本局答案卡。`sealed` 只在本局揭晓时打开：卡片沉一下再被抬起亮相、放回原位（`revealCard`），
 * 与中途对观战者公开的同一张卡区分开（那时还没结算）。
 * 与猜歌答案卡同一排布：窄屏图片在上、文字居中，`sm` 起左图右文。
 * 不展示角色编号；收藏与评论数之和按 Bangumi 的叫法称「人气值」。简介按 Bangumi 维基的富文本渲染，
 * 作为资料表的一行默认收成三行（`ClampedText`）。
 */
export function CEEAnswerCard({
  answer,
  sealed = false,
}: {
  answer: CEECharacterView;
  sealed?: boolean;
}) {
  const title = answer.nameCn || answer.name;
  const info = (
    <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-start sm:text-left">
      <CEECharacterImage
        key={answer.id}
        character={answer}
        size="large"
        className="h-32 w-24 bg-background"
      />
      <div className="w-full min-w-0 flex-1 space-y-3">
        <div className="space-y-0.5">
          <h3 className="break-words text-xl font-semibold">{title}</h3>
          {answer.name !== title ? (
            <p className="break-words text-sm text-muted-foreground">{answer.name}</p>
          ) : null}
        </div>
        <dl className="flex flex-wrap justify-center gap-x-6 gap-y-2 sm:justify-start">
          <Fact label="人气值" value={answer.popularity} />
          <Fact
            label="最高评分"
            value={answer.highestRating === CEE_UNKNOWN_NUMBER ? "未知" : answer.highestRating}
          />
          <Fact label="性别" value={CEE_GENDER_TEXT[answer.gender] ?? "未知"} />
          {answer.earliestAppearance !== CEE_UNKNOWN_NUMBER ? (
            <Fact
              label="登场年份"
              value={
                answer.earliestAppearance === answer.latestAppearance
                  ? answer.earliestAppearance
                  : `${answer.earliestAppearance}–${answer.latestAppearance}`
              }
            />
          ) : null}
        </dl>
        {answer.characterTags.length ? (
          <div className="flex flex-wrap justify-center gap-1 sm:justify-start">
            {answer.characterTags.map((tag) => (
              <Badge key={tag} variant="outline" className="whitespace-nowrap">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
  // 作品、声优、简介是同一张资料表的三行：字段名与内容（排布见 DETAIL_ROW）。简介就地收成三行，右上角箭头展开全文，
  // 不另起一个折叠标题（那样会在卡片里冒出一行没有容器语言的裸文字）。
  const details =
    answer.appearances.length || answer.voiceActors.length || answer.summary ? (
      <dl className="space-y-3 border-t border-background pt-3 text-sm sm:space-y-2">
        {answer.appearances.length ? (
          <div className={DETAIL_ROW}>
            <dt className={DETAIL_LABEL}>作品</dt>
            <dd className="flex min-w-0 flex-wrap gap-1">
              {answer.appearances.map((entry) => (
                <Badge key={entry.id} variant="subtle" className="max-w-full">
                  <span className="truncate">{entry.nameCn || entry.name}</span>
                  {entry.year > 0 ? (
                    <span className="shrink-0 tabular-nums">· {entry.year}</span>
                  ) : null}
                </Badge>
              ))}
            </dd>
          </div>
        ) : null}
        {answer.voiceActors.length ? (
          <div className={DETAIL_ROW}>
            <dt className={DETAIL_LABEL}>声优</dt>
            <dd className="min-w-0 break-words">{answer.voiceActors.join("、")}</dd>
          </div>
        ) : null}
        {answer.summary ? (
          // 字段名与正文取同一行高，并排时两列首行对齐。
          <div className={cn(DETAIL_ROW, "leading-relaxed")}>
            <dt className={DETAIL_LABEL}>简介</dt>
            <dd className="min-w-0 flex-1">
              <ClampedText label="角色简介" lines={3}>
                <CEEBangumiRichText text={answer.summary} />
              </ClampedText>
            </dd>
          </div>
        ) : null}
      </dl>
    ) : null;
  // 揭晓时不另加包装层，直接把外层升为 motion：多一层包裹会打断卡片自身的圆角与留白
  if (!sealed)
    return (
      <div className="space-y-4 rounded-md bg-muted p-4">
        {info}
        {details}
      </div>
    );
  return (
    <motion.div
      initial={revealCard.initial}
      animate={revealCard.animate}
      transition={revealCard.transition}
      className="reveal-lift space-y-4 rounded-md bg-muted p-4"
    >
      {info}
      {details}
    </motion.div>
  );
}
