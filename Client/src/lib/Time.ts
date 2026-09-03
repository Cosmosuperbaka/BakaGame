const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "always" });

/**
 * 格式化相对时间。
 * 基于原生 Intl.RelativeTimeFormat 实现自然中文表达，消除手写日历除法偏差。
 */
export function formatRelativeTime(dateStr: string): string {
  const raw = dateStr.trim();
  // 纯日期缺时区，补零点按本地时间解析，避免被当成 UTC 而偏移一天。
  const then = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw);
  if (Number.isNaN(then.getTime())) return dateStr;

  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);
  // 时钟偏差或未来时间戳，显示刚刚。
  if (seconds <= 0) return "刚刚";

  if (seconds < 60) return rtf.format(-seconds, "second");

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");

  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, "day");

  const months = Math.floor(days / 30);
  if (months < 12) return rtf.format(-months, "month");

  return rtf.format(-Math.floor(months / 12), "year");
}
