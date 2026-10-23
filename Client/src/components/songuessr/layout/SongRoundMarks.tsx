import { Check, Clock3, Flag, Skull, type LucideIcon } from "lucide-react";
import { Hint } from "@/components/ui/Tooltip";
import { cn } from "@/lib/Utils";
import type { SonGuessrRoundMark } from "@bakagame/shared";

/**
 * 逐轮结果到图标的穷举映射。
 *
 * 用 `Record<SonGuessrRoundMark, …>` 而不是运行时按字符查表：协议新增一档结果而这里没补，
 * 编译期就报错，不会像解析标记串那样在页面上留下一个没有含义的空格或错位的图标。
 */
const ROUND_MARK_STYLES: Record<
  SonGuessrRoundMark,
  { icon: LucideIcon; tone: string; label: string }
> = {
  correct: { icon: Check, tone: "text-success", label: "猜中" },
  gaveUp: { icon: Flag, tone: "text-muted-foreground", label: "投降" },
  outOfGuesses: { icon: Skull, tone: "text-destructive", label: "次数用尽" },
  timeout: { icon: Clock3, tone: "text-warning", label: "超时" },
};

/**
 * 玩家栏的逐轮作答结果：一轮一枚图标，按时间从左到右排。
 *
 * 整串作为一个图像读给读屏，悬停说明给出同一份文字序列，不靠颜色单独传达；
 * 结果数组由服务端算好，这里不做任何解析。没有作答过（出题人、其队友、旁观者）时不渲染，
 * 不占一行留白。
 */
export function SongRoundMarks({ marks, name }: { marks: SonGuessrRoundMark[]; name: string }) {
  if (marks.length === 0) return null;

  const description = marks.map((mark) => ROUND_MARK_STYLES[mark].label).join("、");
  const title = `${name} 逐轮结果：${description}`;

  return (
    <Hint label={title}>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1" role="img" aria-label={title}>
        {marks.map((mark, index) => {
          const { icon: Icon, tone } = ROUND_MARK_STYLES[mark];
          return (
            <Icon
              // 同一档结果会出现多次，按序号作键：只追加不重排，已有的图标不会被重新挂载。
              key={`${mark}-${index}`}
              aria-hidden="true"
              className={cn("size-3.5 shrink-0", tone)}
            />
          );
        })}
      </span>
    </Hint>
  );
}
