import type { CEEGuess, ConnectionRecord } from "../shared/Index";
import { AppError } from "../domain/Errors";
import type { CEEPlayerRecord, CEERoom } from "../domain/CEEModel";
import { ceeUnitId } from "../domain/CEEModel";
import {
  applyCEEGuess,
  beginCEERound,
  ceeImageHintAvailability,
  ceeParticipants,
  requireCEEAction,
  tickCEERound,
} from "../domain/CEERound";
import { validateCEESettings } from "../domain/CEERules";
import type { CEEDataProvider } from "../infrastructure/CEEData";
import type { CEEImageHints } from "../infrastructure/CEEImageHints";
import type { CEESearchProvenance } from "./CEEAntiCheatSignals";
import { ceeClientTypeOf } from "./CEEAntiCheatSignals";
import type { CEERooms } from "./CEERooms";

/** 增强房出题与猜测动作的依赖：由 `CEENativeService` 在构造时建一次，动作函数不持有服务本身。 */
export interface CEENativeContext {
  readonly state: CEERooms;
  readonly data: CEEDataProvider;
  readonly imageHints: CEEImageHints;
  readonly now: () => number;
  readonly random: () => number;
  /** 检索台账由入口层持有，这里只读。 */
  readonly provenance?: CEESearchProvenance;
  /** 同一房间同一动作的并发占位：跨 await 的动作先占位、finally 释放。 */
  readonly inFlight: Set<string>;
  /** 每房只留一个「最近截止」定时器：状态变化之后重算。 */
  schedule(room: CEERoom): void;
  /** 命令改变了多间房（重连、关房）之后，给仍在的房间全部重挂。 */
  rescheduleAll(): void;
}

/** 房主与阶段由命令表守卫：调用时房间一定处在选出题人阶段。 */
export function chooseCEESetter(ctx: CEENativeContext, room: CEERoom, playerId: string): void {
  const setter = ctx.state.member(room, playerId);
  if (!setter.online) throw new AppError("PLAYER_OFFLINE", "出题人已离线");
  if (!ceeParticipants(room, setter.id).length)
    throw new AppError("NO_PARTICIPANTS", "出题人及其队友不能参与猜测，请保留其他猜题者");
  room.setterPlayerId = setter.id;
  room.phase = "answering";
  room.preparationId = crypto.randomUUID();
  room.phaseDeadlineAt = ctx.now() + 120000;
}
/** 房主与「有任务可取消」的阶段由命令表守卫。 */
export function cancelCEEPreparation(ctx: CEENativeContext, room: CEERoom): void {
  // 选出题人阶段还没开局，退回等待只换阶段，大家的准备状态原样保留。
  if (room.phase === "choosingSetter") {
    room.phase = "waiting";
    return;
  }
  ctx.state.resetWaiting(room);
}
/**
 * 开始游戏：随机出题直接抽题开局；手动出题进入选出题人阶段，由房主在那里指定出题人。
 * 房主、阶段与「人数与准备」由命令表守卫。
 */
export async function startCEEGame(ctx: CEENativeContext, room: CEERoom): Promise<void> {
  validateCEESettings(room.settings);
  room.round = null;
  room.summary = null;
  room.setterPlayerId = null;
  if (room.settings.answerMode === "manual") {
    room.phase = "choosingSetter";
    return;
  }
  room.phase = "preparing";
  room.phaseDeadlineAt = ctx.now() + 30000;
  const preparationId = crypto.randomUUID();
  room.preparationId = preparationId;
  ctx.state.publishRoom(room);
  ctx.schedule(room);
  try {
    const answer = await ctx.data.chooseRandomCharacter(room.settings, ctx.random);
    if (
      ctx.state.rooms.get(room.id) !== room ||
      room.phase !== "preparing" ||
      room.preparationId !== preparationId ||
      ctx.now() >= room.phaseDeadlineAt!
    )
      throw new AppError("ROUND_CANCELLED", "本次出题已经取消");
    beginCEERound(room, answer, null, ctx.now(), ctx.random);
  } catch (error) {
    if (room.phase === "preparing" && room.preparationId === preparationId)
      ctx.state.resetWaiting(room);
    ctx.state.publishRoom(room);
    ctx.schedule(room);
    throw error;
  }
}
export async function submitCEEAnswer(
  ctx: CEENativeContext,
  room: CEERoom,
  player: CEEPlayerRecord,
  id: number,
  hints: string[]
): Promise<void> {
  const key = `answer:${room.id}`;
  if (ctx.inFlight.has(key)) throw new AppError("ACTION_PENDING", "答案正在提交");
  ctx.inFlight.add(key);
  const preparationId = room.preparationId;
  try {
    const answer = await ctx.data.getCharacter(id, room.settings);
    if (
      ctx.state.rooms.get(room.id) !== room ||
      room.phase !== "answering" ||
      room.setterPlayerId !== player.id ||
      room.preparationId !== preparationId ||
      ctx.now() >= room.phaseDeadlineAt! ||
      !player.online
    )
      throw new AppError("ROUND_CANCELLED", "本次出题已经取消");
    beginCEERound(room, answer, hints, ctx.now(), ctx.random);
  } finally {
    ctx.inFlight.delete(key);
  }
}
export async function submitCEEGuess(
  ctx: CEENativeContext,
  connection: ConnectionRecord,
  room: CEERoom,
  player: CEEPlayerRecord,
  id: number
): Promise<void> {
  const { round, unit } = requireCEEAction(room, player);
  const syncRound = round.syncRound;
  const attempts = unit.attempts;
  const key = `guess:${room.id}:${ceeUnitId(player)}`;
  if (ctx.inFlight.has(key)) throw new AppError("ACTION_PENDING", "队伍猜测正在提交");
  ctx.inFlight.add(key);
  try {
    const loaded = round.characters.get(id) ?? (await ctx.data.getCharacter(id, round.settings));
    if (ctx.state.rooms.get(room.id) !== room || room.round !== round)
      throw new AppError("ROUND_CANCELLED", "本局已经结束");
    // 查询期间时钟仍继续运行；到期先执行扣次，再重新校验行动资格。
    tickCEERound(room, ctx.now());
    requireCEEAction(room, player);
    if (round.syncRound !== syncRound || unit.attempts !== attempts)
      throw new AppError("ROUND_CANCELLED", "本次行动已超时，请重新猜测");
    const character = round.characters.get(id) ?? structuredClone(loaded);
    const guess = applyCEEGuess(room, player, character, ctx.now());
    round.characters.set(id, character);
    noteGuessSignal(ctx, connection, room, guess, unit.attempts, id);
  } finally {
    ctx.inFlight.delete(key);
  }
}
/**
 * 登记本条猜测的服务端可观测切片：谁在猜、第几次、从哪个平台、猜之前有没有检索过。
 * 检索台账按连接记，同一玩家换连接后旧台账不跟着走——那是「同一个人」的判定，不是本特征要问的。
 */
function noteGuessSignal(
  ctx: CEENativeContext,
  connection: ConnectionRecord,
  room: CEERoom,
  guess: CEEGuess,
  attempts: number,
  characterId: number
): void {
  if (!ctx.provenance) return;
  const { at, matched } = ctx.provenance.match(connection.id, characterId);
  ctx.state.recording.noteGuessSignal(room.id, {
    guessId: guess.id,
    playerId: guess.playerId,
    attempts,
    clientType: ceeClientTypeOf(connection.clientChannel),
    searchedAt: at,
    searchMatched: matched,
    correct: guess.correct,
    createdAt: guess.createdAt,
  });
}
export async function requestCEEImageHint(
  ctx: CEENativeContext,
  room: CEERoom,
  player: CEEPlayerRecord
): Promise<{ dataUrl: string }> {
  const hint = ceeImageHintAvailability(room, player);
  const round = room.round;
  if (!hint.available || !round) throw new AppError("HINT_LOCKED", "图片提示尚未解锁");
  const url = await ctx.data.resolveCharacterImage(round.answer.id);
  if (!url) throw new AppError("IMAGE_UNAVAILABLE", "该角色暂时没有图片");
  const dataUrl = await ctx.imageHints.render(url, hint.level);
  if (room.round !== round || !ceeImageHintAvailability(room, player).available)
    throw new AppError("HINT_LOCKED", "图片提示已失效");
  return { dataUrl };
}
