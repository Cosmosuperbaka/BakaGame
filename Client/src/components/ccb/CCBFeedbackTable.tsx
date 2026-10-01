import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Check, Minus, X } from "lucide-react";
import type { CCBFeedbackValue, CCBGuess } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { Collapsible } from "@/components/ui/Collapsible";
import { cn } from "@/lib/Utils";
import { CCBCharacterImage } from "./CCBCharacterImage";

// 比较值来自「猜测减答案」；箭头指向答案，方向与差值相反。
const labels = { "+": "答案更低", "++": "答案低很多", "-": "答案更高", "--": "答案高很多", "=": "相同", "?": "未知", yes: "匹配", no: "不匹配" };
const icons = { "+": ArrowDown, "++": ChevronsDown, "-": ArrowUp, "--": ChevronsUp, "=": Check, "?": Minus, yes: Check, no: X };
const fields = [
  ["gender", "性别"], ["popularity", "收藏"], ["rating", "最高评分"], ["appearancesCount", "作品数"], ["earliestAppearance", "最早年份"], ["latestAppearance", "最近年份"],
] as const;

function FeedbackCell({ data, gender = false }: { data: CCBFeedbackValue; gender?: boolean }) {
  const Icon = icons[data.comparison];
  const unknown = data.value === "" || data.value === "?" || data.value === -1;
  const text = unknown ? "未知" : gender ? ({ male: "男", female: "女" }[String(data.value)] ?? data.value) : data.value;
  const matched = data.comparison === "=" || data.comparison === "yes";
  return <td className={cn("whitespace-nowrap px-1 py-1.5 text-center first:pl-3 last:pr-3", matched && "bg-success/10 text-success")}>
    <span className="inline-flex items-center gap-1" title={labels[data.comparison]}><span>{text}</span><Icon className="h-3.5 w-3.5" aria-label={labels[data.comparison]} /></span>
  </td>;
}

// 角色名与标签横跨整行，横向滚动时贴住可视区左缘、宽度不超过可视区（cqw 取滚动容器宽度，减去两侧 px-3），只有数值列随滚动移动。
const pinnedToView = "sticky left-3 max-w-[calc(100cqw-1.5rem)]";

export function CCBFeedbackTable({ guesses }: { guesses: CCBGuess[] }) {
  if (!guesses.length) return <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">提交第一个猜测后，这里会显示线索</p>;
  return <div className="@container overflow-x-auto rounded-md border" tabIndex={0} role="region" aria-label="猜测反馈">
    <table className="w-full text-sm"><thead className="bg-muted"><tr>{fields.map(([key, label]) => <th key={key} scope="col" className="whitespace-nowrap px-1 py-2 font-medium first:pl-3 last:pr-3">{label}</th>)}</tr></thead>
      {/* 每个猜测一组三行：角色名独占首行作组标题，数值列拿到整宽，中等宽度不必横向滚动；末行整宽放共同作品与标签。 */}
      {guesses.map((guess) => <tbody key={guess.id} className="border-t">
        <tr>
          <th colSpan={fields.length} scope="rowgroup" className="px-3 pt-3 pb-1.5 text-left font-normal"><span className={cn(pinnedToView, "flex gap-2")}><CCBCharacterImage character={guess.character} /><span className="min-w-0 [overflow-wrap:anywhere]"><span className="block font-medium">{guess.character.nameCn || guess.character.name}</span><span className="block text-xs text-muted-foreground">{guess.playerName} · <span className="whitespace-nowrap">第 {guess.syncRound} 轮</span></span>{guess.correct ? <span className="text-xs text-success">猜中</span> : guess.partial ? <span className="text-xs text-muted-foreground">作品命中</span> : null}</span></span></th>
        </tr>
        <tr>{fields.map(([field]) => <FeedbackCell key={field} data={guess.feedback[field]} gender={field === "gender"} />)}</tr>
        <tr>
          <td colSpan={fields.length} className="px-3 pt-1.5 pb-3">
            <div className={cn(pinnedToView, "space-y-2")}>
              {guess.feedback.sharedAppearances.length ? <p className="text-xs text-success">共同作品：{guess.feedback.sharedAppearances.map((subject) => subject.nameCn || subject.name || `作品 ${subject.id}`).join("、")}</p> : null}
              {guess.feedback.tags.length ? <div className="flex flex-wrap gap-1">{guess.feedback.tags.map((tag, index) => <Badge key={`${tag.kind}:${index}`} size="sm" variant={tag.matched && !tag.hidden ? "matched" : "muted"} title={tag.hidden ? "标签已被其他玩家发现" : `${{ subject: "作品", character: "角色", voice: "声优" }[tag.kind]}标签`}>{tag.hidden ? "已隐藏" : tag.text}</Badge>)}</div> : null}
              {guess.feedback.extraTags.length ? <Collapsible title="游戏专属标签" size="sm"><div className="space-y-2 text-xs">{guess.feedback.extraTags.map((group) => <section key={group.section} className="space-y-1"><h4 className="font-medium">{group.section}</h4><div className="flex flex-wrap gap-1">{group.tags.map((tag) => <Badge key={tag.text} size="sm" variant={tag.matched ? "matched" : "muted"}>{tag.text}{tag.matched ? <Check className="h-3 w-3" aria-label="匹配" /> : null}</Badge>)}</div></section>)}</div></Collapsible> : null}
            </div>
          </td>
        </tr>
      </tbody>)}
    </table>
  </div>;
}
