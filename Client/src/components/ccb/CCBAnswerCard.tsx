import type { CCBCharacterView } from "@bakagame/shared";
import { CCBCharacterImage } from "./CCBCharacterImage";

export function CCBAnswerCard({ answer }: { answer: CCBCharacterView }) {
  return <div className="space-y-4 rounded-md border bg-muted/30 p-4">
    <div className="flex items-start gap-4"><CCBCharacterImage key={answer.id} character={answer} className="h-28 w-24" /><div className="min-w-0 space-y-2"><h3 className="text-xl font-semibold">{answer.nameCn || answer.name}</h3><p className="text-sm text-muted-foreground">{answer.name} · #{answer.id}</p><p className="text-xs text-muted-foreground">{answer.popularity} 人收藏 · 最高评分 {answer.highestRating}</p><div className="flex flex-wrap gap-1">{answer.characterTags.map((tag) => <span key={tag} className="rounded-md bg-muted px-2 py-1 text-xs">{tag}</span>)}</div></div></div>
    {answer.appearances.length ? <p className="text-sm">登场作品：{answer.appearances.map((entry) => entry.nameCn || entry.name).join("、")}</p> : null}
    {answer.voiceActors.length ? <p className="text-sm">声优：{answer.voiceActors.join("、")}</p> : null}
    {answer.summary ? <details><summary className="cursor-pointer text-sm text-muted-foreground">角色简介</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{answer.summary}</p></details> : null}
  </div>;
}
