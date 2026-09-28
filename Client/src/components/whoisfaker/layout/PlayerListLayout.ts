import { PLAYER_COLUMN_WIDTH } from "@/components/common/PlayerStatusPill";

/**
 * 玩家列宽度由公共模块单一持有，这里只做转发，供发言历史的列轨道复用。
 * 必须以 rem 表达：全局字号为 120%，`1rem` 不等于 `16px`，
 * 写成像素常量会让分界线落进玩家列内部。
 */
export { PLAYER_COLUMN_WIDTH };

const SPEECH_COLUMN_MIN_WIDTH = 200;

/** 空历史不能生成无效的 `repeat(0, ...)`，否则浏览器会丢弃整条列定义。 */
export const speechGridTemplate = (columnCount: number) =>
  columnCount > 0
    ? `${PLAYER_COLUMN_WIDTH} repeat(${columnCount}, minmax(${SPEECH_COLUMN_MIN_WIDTH}px, max-content))`
    : PLAYER_COLUMN_WIDTH;
