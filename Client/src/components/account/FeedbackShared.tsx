import { Hint } from "@/components/ui/Tooltip";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/Time";

/**
 * 两个标签共用的定高滚动区。全站不画滚动条，内容超出时上下淡出一段（scroll-fade-y），
 * 读得出「下面还有」——游客的二次确认框就落在底部，不淡出时只露半截按钮像是被切坏了。
 * 上下内边距给淡出段留位，首末行停稳后不被淡掉。
 */
export const PANEL = "scrollbar-hidden scroll-fade-y h-[min(56vh,30rem)] py-3";

export function Time({ value }: { value: string }) {
  return (
    <Hint label={formatAbsoluteTime(value)}>
      <time dateTime={value}>{formatRelativeTime(value)}</time>
    </Hint>
  );
}
