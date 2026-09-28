import { Check, Clock, Crown, Flag, Lightbulb, Skull, Star, Trophy, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/Utils";

/**
 * 服务端 `marks` 是逐次猜测的结果串，原版房直接沿用上游原样，客户端不改协议，
 * 只在渲染层把标记翻译成图标：结果由形状区分，颜色只做强调。
 * 逐次错误与超时是最常见的标记，取次要前景色保持整行安静；
 * 命中、首猜与获胜才着色，让该被看见的结果浮出来。
 */
interface MarkStyle {
  icon: LucideIcon;
  label: string;
  tone: string;
}

const MARK_STYLES: Record<string, MarkStyle> = {
  "✔": { icon: Check, label: "猜中", tone: "text-success" },
  "✅": { icon: Check, label: "猜中", tone: "text-success" },
  "💡": { icon: Lightbulb, label: "作品命中", tone: "text-warning" },
  "👑": { icon: Crown, label: "首次猜中", tone: "text-warning" },
  "✌": { icon: Star, label: "猜中", tone: "text-success" },
  "🏆": { icon: Trophy, label: "队伍获胜", tone: "text-warning" },
  "❌": { icon: X, label: "未命中", tone: "text-muted-foreground" },
  // 上游有的标记带变体选择符、有的不带，两种写法都要认。
  "⏱": { icon: Clock, label: "超时", tone: "text-muted-foreground" },
  "⏱️": { icon: Clock, label: "超时", tone: "text-muted-foreground" },
  "💀": { icon: Skull, label: "次数用尽", tone: "text-muted-foreground" },
  "🏳": { icon: Flag, label: "已放弃", tone: "text-muted-foreground" },
  "🏳️": { icon: Flag, label: "已放弃", tone: "text-muted-foreground" },
};

// 带变体选择符的组合标记要整段匹配，否则会被拆成一个基字符加一个选择符。
// 兜底分支按码位切分，上游新增标记时仍能原样显示，不会静默丢字符。
const MARK_TOKEN = /⏱️|🏳️|[\s\S]/gu;

/** 孤立的选择符是上面兜底切分的残留，不单独成项。 */
const VARIATION_SELECTOR = /^️$/u;

/**
 * 猜测进度。整串作为一个图像读给读屏，逐次结果以图标呈现，
 * 悬停提示给出同一份文字描述，不依赖颜色传达。
 */
export function CCBMarks({ marks, name }: { marks: string; name: string }) {
  const items = (marks.match(MARK_TOKEN) ?? [])
    .filter((token) => !VARIATION_SELECTOR.test(token))
    .map((token, index) => ({ token, index, style: MARK_STYLES[token] as MarkStyle | undefined }));
  if (!items.length) return null;

  const description = items.map((item) => item.style?.label ?? item.token).join("、");
  const title = `${name} 猜测进度：${description}`;

  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5"
      role="img"
      title={title}
      aria-label={title}
    >
      {items.map(({ token, index, style }) =>
        style ? (
          <style.icon key={`${token}-${index}`} aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0", style.tone)} />
        ) : (
          <span key={`${token}-${index}`} className="text-xs leading-none text-muted-foreground">{token}</span>
        ),
      )}
    </span>
  );
}
