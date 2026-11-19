import { serverNow } from "@/stores/UseServerClock";

const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "always" });

/** 解析时间串；非法输入返回 null，调用方原样回退。 */
function parseInstant(dateStr: string): Date | null {
  const raw = dateStr.trim();
  // 纯日期缺时区，补零点按本地时间解析，避免被当成 UTC 而偏移一天。
  const then = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw);
  return Number.isNaN(then.getTime()) ? null : then;
}

/**
 * 格式化相对时间。
 * 基于原生 Intl.RelativeTimeFormat 实现自然中文表达，消除手写日历除法偏差。
 */
export function formatRelativeTime(dateStr: string): string {
  const then = parseInstant(dateStr);
  if (!then) return dateStr;

  const seconds = Math.floor((serverNow() - then.getTime()) / 1000);
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

/** 绝对时间一律按北京时间写（与后台、构建时间同口径），格式器建一次复用，不随系统时区变化。 */
const ABSOLUTE_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  // h23：午夜写 00:00，不写 24:00。
  hourCycle: "h23",
});

/**
 * 格式化绝对时间，用相对时间的悬停提示。
 * 「3 天前」说不出到底是哪一天，排查「我这边是不是旧版本」时需要确切时刻。
 */
export function formatAbsoluteTime(dateStr: string): string {
  const then = parseInstant(dateStr);
  if (!then) return dateStr;

  return ABSOLUTE_FORMAT.format(then);
}
