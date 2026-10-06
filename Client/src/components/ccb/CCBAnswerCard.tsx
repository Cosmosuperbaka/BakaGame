import { motion } from "framer-motion";
import type { CCBCharacterView } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { Collapsible } from "@/components/ui/Collapsible";
import { Seal } from "@/components/ui/Seal";
import { sealCard } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { CCBCharacterImage } from "./CCBCharacterImage";

/**
 * 本局答案卡。`sealed` 只在本局揭晓时打开：卡片回弹落定、答案落在卡上，
 * 与中途对观战者公开的同一张卡区分开（那时还没结算，没有答案可落款）。
 * 与猜歌答案卡同一排布：窄屏图片在上、文字居中，`sm` 起左图右文；印章只在横排时让出右侧。
 */
export function CCBAnswerCard({ answer, sealed = false }: { answer: CCBCharacterView; sealed?: boolean }) {
  const info = (
    <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-start sm:text-left">
      <CCBCharacterImage key={answer.id} character={answer} className="h-28 w-24 bg-background" />
      <div className={cn("min-w-0 flex-1 space-y-2", sealed && "sm:pr-16")}>
        <h3 className="break-words text-xl font-semibold">{answer.nameCn || answer.name}</h3>
        <p className="break-words text-sm text-muted-foreground">{answer.name} · #{answer.id}</p>
        <p className="text-xs text-muted-foreground">
          <span className="whitespace-nowrap">{answer.popularity} 人收藏</span> · <span className="whitespace-nowrap">最高评分 {answer.highestRating === -1 ? "未知" : answer.highestRating}</span>
        </p>
        <div className="flex flex-wrap justify-center gap-1 sm:justify-start">
          {answer.characterTags.map((tag) => <Badge key={tag} variant="outline" className="whitespace-nowrap">{tag}</Badge>)}
        </div>
      </div>
    </div>
  );
  const details = <>{answer.appearances.length ? <p className="text-sm">登场作品：{answer.appearances.map((entry) => entry.nameCn || entry.name).join("、")}</p> : null}{answer.voiceActors.length ? <p className="text-sm">声优：{answer.voiceActors.join("、")}</p> : null}{answer.summary ? <Collapsible title="角色简介"><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{answer.summary}</p></Collapsible> : null}</>;
  // 落款时不另加包装层，直接把外层升为 motion：多一层包裹会打断卡片自身的圆角与留白
  if (!sealed) return <div className="space-y-4 rounded-md bg-muted p-4">{info}{details}</div>;
  return <motion.div initial={sealCard.initial} animate={sealCard.animate} transition={sealCard.transition} className="relative space-y-4 rounded-md bg-muted p-4"><Seal label="揭晓" className="absolute right-4 top-4" />{info}{details}</motion.div>;
}
