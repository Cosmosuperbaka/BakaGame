import { ACCOUNT_NAME_CHANGE_COOLDOWN_MS } from "@bakagame/shared/values";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** 冷却天数只从共享常量换算，文案不另写一份数字。 */
export const ACCOUNT_NAME_COOLDOWN_DAYS = Math.round(ACCOUNT_NAME_CHANGE_COOLDOWN_MS / DAY_MS);

/**
 * 下次可改名的时刻（毫秒）；从未改过名（老账号）返回 `null`，表示随时可改。
 * 口径与服务端一致：上次改名时刻（新号为注册时刻）加共享的冷却时长。
 */
export const nameChangeAvailableAt = (nameChangedAt: string | null): number | null => {
  if (!nameChangedAt) return null;
  const changed = Date.parse(nameChangedAt);
  return Number.isNaN(changed) ? null : changed + ACCOUNT_NAME_CHANGE_COOLDOWN_MS;
};

const minuteFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `11月29日 14:30`：与服务端冷却报错同一种写法，玩家前后看到的是同一个时刻。 */
export const formatNameChangeTime = (time: number): string => {
  const parts = Object.fromEntries(
    minuteFormat.formatToParts(time).map((part) => [part.type, part.value])
  );
  return `${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
};

/** 冷却剩余时间的粗粒度说法：够一天按天，不够按小时，最后一小时内说「不到 1 小时」。 */
export const formatNameCooldownLeft = (left: number): string => {
  if (left >= DAY_MS) return `${Math.ceil(left / DAY_MS)} 天`;
  if (left >= HOUR_MS) return `${Math.ceil(left / HOUR_MS)} 小时`;
  return "不到 1 小时";
};
