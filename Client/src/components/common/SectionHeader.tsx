import { UserCheck } from "lucide-react";

/** 区块小标题。`hint` 是右侧的补充说明，缺省时右侧留空。 */
export function SectionHeader({
  title,
  icon,
  hint,
}: {
  title: string;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-2.5 px-1">
      {/* 区块小标题与结算表、设置小节同一口径：标题标签（衬线）+ xs 半粗弱化色 */}
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        {icon ?? <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />}
        {title}
      </h3>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
