const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 北京时间自然日 `YYYY-MM-DD`，与库内按日统计同一口径。
 * 放在领域层：统计服务、后台汇总与状态历史仓储都按它切日，基础设施不该反向依赖应用服务取这把尺子。
 */
export const beijingDay = (time: number): string =>
  new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
