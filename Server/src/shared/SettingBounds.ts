// ==================== 设置项的数值界限（纯值） ====================
// 校验的权威来源是 shared 的 TypeBox schema，客户端设置字段不再手抄一份数字：
// 两边都从这里取，放宽或收紧只改一处。本文件不得引入 TypeBox——客户端经
// `@bakagame/shared/values` 取值时不能把校验库带进首屏包。

/** 作品年份：CEE 的抽题年份与猜歌的番剧年份是同一取值段。 */
export const SUBJECT_YEAR_BOUNDS = { min: 1900, max: 2200 } as const;

export const CEE_SETTING_BOUNDS = {
  topNSubjects: { min: 1, max: 1000 },
  characterNum: { min: 1, max: 100 },
} as const;

export const SONG_SUBJECT_LIMIT_BOUNDS = { min: 1, max: 1000 } as const;
