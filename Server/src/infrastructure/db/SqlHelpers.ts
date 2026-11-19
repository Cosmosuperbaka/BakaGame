import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * UTC 落库时间 → 北京时间自然日（`YYYY-MM-DD`）。
 *
 * 业务「自然日」统一按北京时间换算，不依赖库端时区；所有按日聚合的仓储共用这一份表达式，
 * 避免各处各写一遍后口径漂移。
 */
export const beijingDayOf = (column: AnyColumn): SQL<string> =>
  sql<string>`date_format(date_add(${column}, interval 8 hour), '%Y-%m-%d')`;

/** 按批大小切开；空数组返回空列表，调用方据此跳过语句。 */
export const inBatches = <T>(items: readonly T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    batches.push(items.slice(index, index + size));
  return batches;
};
