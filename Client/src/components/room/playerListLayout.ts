/** 玩家列宽度，同时用于面板、网格首列与分界线定位。 */
export const PLAYER_COLUMN_WIDTH = "16rem";

const SPEECH_COLUMN_MIN_WIDTH = 200;

/** 空历史不能生成无效的 `repeat(0, ...)`，否则浏览器会丢弃整条列定义。 */
export const speechGridTemplate = (columnCount: number) =>
  columnCount > 0
    ? `${PLAYER_COLUMN_WIDTH} repeat(${columnCount}, minmax(${SPEECH_COLUMN_MIN_WIDTH}px, max-content))`
    : PLAYER_COLUMN_WIDTH;
