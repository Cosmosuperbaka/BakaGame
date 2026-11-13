import {
  BOT_NAME_SUFFIXES,
  TEST_BOT_BATCH_LIMIT,
  TEST_MODE_MAX_PLAYERS,
} from "../../../config/Constants";
import { AppError } from "../../../domain/Errors";
import type { SonGuessrContext } from "../Context";
import { clampInt } from "../Records";
import { createPlayer, type SongCommandAt } from "../RoomAccess";
import { finishRound, isRoundComplete } from "../RoundEngine";

export function addBots(ctx: SonGuessrContext, at: SongCommandAt, countValue?: number) {
  const { room } = at;
  const currentCount = Object.values(room.players).length;
  if (currentCount >= TEST_MODE_MAX_PLAYERS) {
    throw new AppError("ROOM_FULL", `测试房间最多 ${TEST_MODE_MAX_PLAYERS} 名玩家`);
  }
  // 单条指令的批量上限只约束「一次能加多少」，必须再卡一次总人数：
  // 否则反复调用就能把房间撑到任意规模，内存与全房广播量都无上界。
  const count = clampInt(
    countValue ?? 1,
    1,
    Math.min(TEST_BOT_BATCH_LIMIT, TEST_MODE_MAX_PLAYERS - currentCount)
  );
  const added: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const botIndex = Object.values(room.players).filter((candidate) => candidate.isBot).length;
    const suffix = BOT_NAME_SUFFIXES[botIndex] ?? String(botIndex + 1);
    const bot = createPlayer(ctx, `测试人机 ${suffix}`, false, true);
    bot.isReady = true;
    room.players[bot.id] = bot;
    added.push(bot.id);
  }
  ctx.touch(room);
  ctx.publishRoom(room);
  return { addedPlayerIds: added };
}

export function removeBots(ctx: SonGuessrContext, at: SongCommandAt, countValue?: number) {
  const { room } = at;
  const count = clampInt(countValue ?? 1, 1, TEST_BOT_BATCH_LIMIT);
  const bots = Object.values(room.players)
    .filter((candidate) => candidate.isBot)
    .sort((left, right) => right.joinedAt - left.joinedAt)
    .slice(0, count);
  for (const bot of bots) delete room.players[bot.id];
  if (room.phase === "playing" && isRoundComplete(ctx, room)) finishRound(ctx, room);
  ctx.touch(room);
  ctx.publishRoom(room);
  return { removedPlayerIds: bots.map((bot) => bot.id) };
}
