import { motion } from "framer-motion";
import type { CCBCharacterView } from "@bakagame/shared";
import { BangumiRichText } from "@/components/common/BangumiRichText";
import { Badge } from "@/components/ui/Badge";
import { Collapsible } from "@/components/ui/Collapsible";
import { revealCard } from "@/lib/Motion";
import { CCBCharacterImage } from "./CCBCharacterImage";

const GENDER_TEXT: Record<CCBCharacterView["gender"], string> = { female: "女", male: "男", "?": "未知" };

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
 * 本局答案卡。`sealed` 只在本局揭晓时打开：卡片回弹落定，
 * 与中途对观战者公开的同一张卡区分开（那时还没结算）。
 * 与猜歌答案卡同一排布：窄屏图片在上、文字居中，`sm` 起左图右文。
 * 不展示角色编号；收藏与评论数之和按 Bangumi 的叫法称「人气值」。简介按 Bangumi 维基的富文本渲染。
 */
export function CCBAnswerCard({ answer, sealed = false }: { answer: CCBCharacterView; sealed?: boolean }) {
  const title = answer.nameCn || answer.name;
  const info = (
    <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-start sm:text-left">
      <CCBCharacterImage key={answer.id} character={answer} className="h-32 w-24 bg-background" />
      <div className="w-full min-w-0 flex-1 space-y-3">
        <div className="space-y-0.5">
          <h3 className="break-words text-xl font-semibold">{title}</h3>
          {answer.name !== title ? <p className="break-words text-sm text-muted-foreground">{answer.name}</p> : null}
        </div>
        <dl className="flex flex-wrap justify-center gap-x-6 gap-y-2 sm:justify-start">
          <Fact label="人气值" value={answer.popularity} />
          <Fact label="最高评分" value={answer.highestRating === -1 ? "未知" : answer.highestRating} />
          <Fact label="性别" value={GENDER_TEXT[answer.gender] ?? "未知"} />
          {answer.earliestAppearance !== -1 ? (
            <Fact label="登场年份" value={answer.earliestAppearance === answer.latestAppearance ? answer.earliestAppearance : `${answer.earliestAppearance}–${answer.latestAppearance}`} />
          ) : null}
        </dl>
        {answer.characterTags.length ? (
          <div className="flex flex-wrap justify-center gap-1 sm:justify-start">
            {answer.characterTags.map((tag) => <Badge key={tag} variant="outline" className="whitespace-nowrap">{tag}</Badge>)}
          </div>
        ) : null}
      </div>
    </div>
  );
  const details = (
    <>
      {answer.appearances.length || answer.voiceActors.length ? (
        <dl className="space-y-2 border-t border-background pt-3 text-sm">
          {answer.appearances.length ? (
            <div className="flex gap-3">
              <dt className="w-10 shrink-0 text-muted-foreground">作品</dt>
              <dd className="flex min-w-0 flex-wrap gap-1">
                {answer.appearances.map((entry) => (
                  <Badge key={entry.id} variant="subtle" className="max-w-full">
                    <span className="truncate">{entry.nameCn || entry.name}</span>
                    {entry.year > 0 ? <span className="shrink-0 tabular-nums">· {entry.year}</span> : null}
                  </Badge>
                ))}
              </dd>
            </div>
          ) : null}
          {answer.voiceActors.length ? (
            <div className="flex gap-3">
              <dt className="w-10 shrink-0 text-muted-foreground">声优</dt>
              <dd className="min-w-0 break-words">{answer.voiceActors.join("、")}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {answer.summary ? (
        <Collapsible title="角色简介">
          <BangumiRichText text={answer.summary} className="text-sm leading-relaxed" />
        </Collapsible>
      ) : null}
    </>
  );
  // 揭晓时不另加包装层，直接把外层升为 motion：多一层包裹会打断卡片自身的圆角与留白
  if (!sealed) return <div className="space-y-4 rounded-md bg-muted p-4">{info}{details}</div>;
  return <motion.div initial={revealCard.initial} animate={revealCard.animate} transition={revealCard.transition} className="space-y-4 rounded-md bg-muted p-4">{info}{details}</motion.div>;
}
