import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Check, Minus, X } from "lucide-react";
import type { CCBFeedbackValue, CCBGuess } from "@bakagame/shared";
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
  return <td className={cn("whitespace-nowrap px-3 py-3 text-center", matched && "bg-success/10 text-success")}>
    <span className="inline-flex items-center gap-1" title={labels[data.comparison]}><span>{text}</span><Icon className="h-3.5 w-3.5" aria-label={labels[data.comparison]} /></span>
  </td>;
}

export function CCBFeedbackTable({ guesses }: { guesses: CCBGuess[] }) {
  if (!guesses.length) return <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">提交第一个猜测后，这里会显示线索</p>;
  return <div className="overflow-x-auto rounded-md border" tabIndex={0} role="region" aria-label="猜测反馈">
    <table className="w-full text-sm"><thead className="bg-muted"><tr><th scope="col" className="min-w-40 px-3 py-2 text-left">猜测角色</th>{fields.map(([key, label]) => <th key={key} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{label}</th>)}<th scope="col" className="min-w-40 px-3 py-2 text-left">共同作品与标签</th></tr></thead>
      <tbody>{guesses.map((guess) => <tr key={guess.id} className="border-t align-top">
        <th scope="row" className="px-3 py-3 text-left font-normal"><span className="flex gap-2"><CCBCharacterImage character={guess.character} /><span className="min-w-0"><span className="block font-medium">{guess.character.nameCn || guess.character.name}</span><span className="block text-xs text-muted-foreground">{guess.playerName} · 第 {guess.syncRound} 轮</span>{guess.correct ? <span className="text-xs text-success">猜中</span> : guess.partial ? <span className="text-xs text-muted-foreground">作品命中</span> : null}</span></span></th>
        {fields.map(([field]) => <FeedbackCell key={field} data={guess.feedback[field]} gender={field === "gender"} />)}
        <td className="space-y-2 px-3 py-3"><div className="space-y-1">{guess.feedback.sharedAppearances.map((subject) => <p key={subject.id} className="text-xs text-success">{subject.nameCn || subject.name || `作品 ${subject.id}`}</p>)}</div><div className="flex min-w-40 flex-wrap gap-1">{guess.feedback.tags.map((tag, index) => <span key={`${tag.kind}:${index}`} className={cn("rounded-md bg-muted px-1.5 py-0.5 text-xs", tag.matched && !tag.hidden && "bg-success/10 text-success")} title={tag.hidden ? "标签已被其他玩家发现" : `${{ subject: "作品", character: "角色", voice: "声优" }[tag.kind]}标签`}>{tag.hidden ? "已隐藏" : tag.text}</span>)}</div>
          {guess.feedback.extraTags.length ? <details className="text-xs"><summary className="cursor-pointer py-1 text-muted-foreground">游戏专属标签</summary><div className="space-y-2 pt-2">{guess.feedback.extraTags.map((group) => <section key={group.section} className="space-y-1"><h4 className="font-medium">{group.section}</h4><div className="flex flex-wrap gap-1">{group.tags.map((tag) => <span key={tag.text} className={cn("inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5", tag.matched && "bg-success/10 text-success")}>{tag.text}{tag.matched ? <Check className="h-3 w-3" aria-label="匹配" /> : null}</span>)}</div></section>)}</div></details> : null}
        </td>
      </tr>)}</tbody>
    </table>
  </div>;
}
