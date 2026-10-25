import type { RecordedGameKind } from "@bakagame/shared";

/** 管理后台共用的文案与格式：游戏名、审计动作、北京时间。 */

export const GAME_LABELS: Record<RecordedGameKind, string> = {
  faker: "谁是卧底",
  song: "猜歌",
  cee: "CEE",
};

export const GAME_OPTIONS: Array<{ value: RecordedGameKind; label: string }> = [
  { value: "faker", label: GAME_LABELS.faker },
  { value: "song", label: GAME_LABELS.song },
  { value: "cee", label: GAME_LABELS.cee },
];

/** 审计动作名与服务端 `AdminService` 的写操作一一对应；未知动作原样显示。 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "user.ban": "封禁用户",
  "user.unban": "解封用户",
  "user.setRole": "修改角色",
  "user.revokeSessions": "强制下线",
  "user.grantBadge": "授予徽章",
  "user.revokeBadge": "撤销徽章",
  "feedback.reply": "回复反馈",
  "feedback.setStatus": "修改反馈状态",
  "room.close": "关闭房间",
  "room.kick": "移出玩家",
  "runtimeSetting.update": "修改运行期设置",
  "qq.refreshNames": "刷新 QQ 昵称",
  "statusEvent.create": "发布状态事件",
  "statusEvent.update": "修改状态事件",
  "statusEvent.delete": "删除状态事件",
};

export const auditActionLabel = (action: string) => AUDIT_ACTION_LABELS[action] ?? action;

export const ROLE_LABELS = { user: "用户", admin: "管理员" } as const;

// 后台给运营看，时刻一律按北京时间写，不随浏览器所在时区漂移。
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const shortDateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const parse = (value: string | number) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** `2026/10/13 08:05` */
export const formatDateTime = (value: string | number) => {
  const date = parse(value);
  return date ? dateTime.format(date) : String(value);
};

/** `10/13 08:05`，表格里省掉年份。 */
export const formatShortDateTime = (value: string | number) => {
  const date = parse(value);
  return date ? shortDateTime.format(date) : String(value);
};

/** 对局时长：`3 分 05 秒` / `42 秒`。 */
export const formatDuration = (from: string, to: string) => {
  const start = parse(from);
  const end = parse(to);
  if (!start || !end) return "";
  const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
};

/** 日期键 `2026-10-13` 写成 `10-13`。 */
export const formatDayKey = (day: string) => day.slice(5);

export const formatNumber = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : value.toLocaleString("zh-CN");

/** 毫秒耗时：小于 1 秒写毫秒，否则写一位小数的秒。 */
export const formatMs = (value: number | null) => {
  if (value === null) return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
};

/** 封禁时长选项（小时）；`0` 表示永久。 */
export const BAN_DURATIONS = [
  { value: "24", label: "1 天" },
  { value: "168", label: "7 天" },
  { value: "720", label: "30 天" },
  { value: "0", label: "永久" },
];
