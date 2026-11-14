import type { GameId } from "../shared/Protocol";

/** 普通命令的等待上限。 */
export const COMMAND_TIMEOUT_MS = 20_000;
/** 出题、开局、下一轮这类上游装配是长任务，由调用方显式放宽。 */
export const LONG_COMMAND_TIMEOUT_MS = 180_000;

/**
 * 屏幕操作发给各游戏的命令超时：按游戏声明在这一处，调整只改这张表。
 * 三个值是历史取值，在没有各命令的延迟数据之前保持原样，不据此推断哪类命令该多久。
 */
export const GAME_COMMAND_TIMEOUT_MS: Record<GameId, number> = {
  faker: COMMAND_TIMEOUT_MS,
  song: LONG_COMMAND_TIMEOUT_MS,
  cee: 120_000,
};
