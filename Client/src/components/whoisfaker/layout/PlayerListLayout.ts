import { PLAYER_COLUMN_WIDTH } from "@/components/common/PlayerStatusPill";

/**
 * 玩家列宽度由公共模块单一持有，这里只做转发，供发言历史的列轨道复用。
 * 必须以 rem 表达：全局字号为 120%，`1rem` 不等于 `16px`，
 * 写成像素常量会让分界线落进玩家列内部。
 */
export { PLAYER_COLUMN_WIDTH };

/**
 * 发言列的最小宽度。侧栏展开的发言历史、移动端面板与战报表格共用这一个值，
 * 同样以 rem 表达，与玩家列按同一根字号缩放。
 */
export const SPEECH_COLUMN_MIN_WIDTH = "10rem";

/**
 * 移动端发言历史面板的玩家列：只放头像与名字，把宽度让给发言列。
 * 16rem 的完整玩家列在手机上会把发言列挤到只剩几个字。
 */
export const COMPACT_PLAYER_COLUMN_WIDTH = "7rem";

/** 空历史不能生成无效的 `repeat(0, ...)`，否则浏览器会丢弃整条列定义。 */
export const speechGridTemplate = (columnCount: number, playerColumn: string = PLAYER_COLUMN_WIDTH) =>
  columnCount > 0
    ? `${playerColumn} repeat(${columnCount}, minmax(${SPEECH_COLUMN_MIN_WIDTH}, max-content))`
    : playerColumn;
