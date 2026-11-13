import { randomUUID } from "node:crypto";
import { AppError } from "../domain/Errors";
import { buildCEEFeedback } from "../domain/CEERules";
import {
  encodeOriginalCharacter,
  toOriginalCharacter,
  toOriginalSettings,
} from "../infrastructure/CEEOriginalProtocol";
import type { CEECharacterView } from "../shared/CEE";
import {
  cancelPreparation,
  publish,
  requireHost,
  selfOf,
  upstreamRequest,
  type CEEOriginalContext,
} from "./CEEOriginalContext";
import type { CEEOriginalPreparation, CEEOriginalSession } from "./CEEOriginalModel";
import type { CEEOriginalRoundData } from "./CEEOriginalRoundData";
import { originalPrivateState } from "./CEEOriginalView";

export function beginPreparation(
  ctx: CEEOriginalContext,
  session: CEEOriginalSession
): CEEOriginalPreparation {
  const phase = session.phase;
  if (
    !session.connectionId ||
    (phase !== "waiting" && phase !== "settled" && phase !== "answering")
  ) {
    throw new AppError("CEE_ROUND_CHANGED", "准备状态已变化");
  }
  const room = ctx.chats.get(session.roomId)!;
  const operation: CEEOriginalPreparation = {
    id: randomUUID(),
    connectionId: session.connectionId,
    phase,
    hostId: session.players.find((player) => player.isHost)?.id || "",
    roomGeneration: room.generation,
    roundKey: room.round?.id ?? null,
    settings: structuredClone(session.settings),
  };
  session.preparation = operation;
  if (phase !== "answering") {
    session.phase = "preparing";
    publish(ctx, session);
  }
  return operation;
}

export function ownsPreparation(
  ctx: CEEOriginalContext,
  session: CEEOriginalSession,
  operation: CEEOriginalPreparation
): boolean {
  const room = ctx.chats.get(session.roomId);
  const phase = operation.phase === "answering" ? "answering" : "preparing";
  const state = originalPrivateState({ ...session, phase: operation.phase });
  return (
    session.preparation?.id === operation.id &&
    !session.revoked &&
    session.confirmed &&
    session.socket.connected &&
    session.connectionId === operation.connectionId &&
    ctx.connections.has(operation.connectionId) &&
    ctx.byConnection.get(operation.connectionId) === session &&
    session.phase === phase &&
    room?.generation === operation.roomGeneration &&
    (room.round?.id ?? null) === operation.roundKey &&
    (session.players.find((player) => player.isHost)?.id || "") === operation.hostId &&
    (operation.phase === "answering" ? state.canSetAnswer : state.canStart)
  );
}

export function requirePreparation(
  ctx: CEEOriginalContext,
  session: CEEOriginalSession,
  operation: CEEOriginalPreparation
): void {
  if (!ownsPreparation(ctx, session, operation))
    throw new AppError("CEE_ROUND_CHANGED", "准备操作已失效，请重新操作");
}

/** 手动出题：开局条件与随机出题相同，满足后进入本服务端的选出题人阶段。 */
export function enterChoosingSetter(ctx: CEEOriginalContext, session: CEEOriginalSession): unknown {
  requireHost(session);
  if (!originalPrivateState(session).canStart)
    throw new AppError("CEE_CANNOT_START", "请等待玩家准备或本局结束");
  session.choosingSetterFrom = session.phase === "settled" ? "settled" : "waiting";
  session.phase = "choosingSetter";
  publish(ctx, session);
  return {};
}

export function leaveChoosingSetter(session: CEEOriginalSession): void {
  if (session.phase === "choosingSetter") session.phase = session.choosingSetterFrom ?? "waiting";
  delete session.choosingSetterFrom;
}

export async function startRound(
  ctx: CEEOriginalContext,
  session: CEEOriginalSession
): Promise<unknown> {
  requireHost(session);
  if (!originalPrivateState(session).canStart)
    throw new AppError("CEE_CANNOT_START", "请等待玩家准备或本局结束");
  const operation = beginPreparation(ctx, session);
  try {
    const character = await ctx.options.data.chooseRandomCharacter(operation.settings);
    requirePreparation(ctx, session, operation);
    if (!character.imageUrl) {
      character.imageUrl = await ctx.options.data.resolveCharacterImage(character.id);
      requirePreparation(ctx, session, operation);
    }
    return await upstreamRequest(ctx, session.socket, "gameStart", {
      roomId: session.roomId,
      character: encodeOriginalCharacter(character, ctx.options.aesSecret!),
      settings: toOriginalSettings(operation.settings),
    });
  } finally {
    if (session.preparation?.id === operation.id) {
      cancelPreparation(session);
      publish(ctx, session);
    }
  }
}

export async function submitAnswer(
  ctx: CEEOriginalContext,
  session: CEEOriginalSession,
  id: number,
  hints: string[]
): Promise<unknown> {
  if (!originalPrivateState(session).canSetAnswer)
    throw new AppError("CEE_NOT_SETTER", "只有指定出题人可以提交答案");
  const operation = beginPreparation(ctx, session);
  try {
    const character = await ctx.options.data.getCharacter(id, operation.settings);
    requirePreparation(ctx, session, operation);
    if (!character.imageUrl) {
      character.imageUrl = await ctx.options.data.resolveCharacterImage(id);
      requirePreparation(ctx, session, operation);
    }
    return await upstreamRequest(ctx, session.socket, "setAnswer", {
      roomId: session.roomId,
      character: encodeOriginalCharacter(character, ctx.options.aesSecret!),
      hints,
    });
  } finally {
    if (session.preparation?.id === operation.id) cancelPreparation(session);
  }
}

export async function submitGuess(
  ctx: CEEOriginalContext,
  session: CEEOriginalSession,
  id: number
): Promise<unknown> {
  if (!originalPrivateState(session).canGuess || !session.answer)
    throw new AppError("CEE_CANNOT_GUESS", "当前不能猜测");
  const roundKey = session.roundKey;
  const syncRound = session.syncRound;
  const attempts = selfOf(session).attempts;
  const data = roundData(ctx, session);
  if (ctx.chats.get(session.roomId)!.round!.phase !== "guessing")
    throw new AppError("CEE_ROUND_CHANGED", "本局状态已变化");
  const [answer, character] = await Promise.all([
    supplementAnswer(ctx, session),
    data.getCharacter(id, session.settings),
  ]);
  if (
    !isCurrentRound(ctx, session, roundKey) ||
    session.syncRound !== syncRound ||
    selfOf(session).attempts !== attempts ||
    !originalPrivateState(session).canGuess
  )
    throw new AppError("CEE_ROUND_CHANGED", "本轮状态已变化，请重新操作");
  const feedback = buildCEEFeedback(character, answer, session.settings);
  const tags = session.settings.tagBan
    ? feedback.tags.filter((tag) => tag.matched).map((tag) => tag.text)
    : [];
  const result = await upstreamRequest(ctx, session.socket, "playerGuess", {
    roomId: session.roomId,
    guessResult: {
      isCorrect: id === answer.id,
      isPartialCorrect: feedback.sharedAppearances.length > 0,
      guessData: toOriginalCharacter(character),
    },
    sharedMetaTags: tags,
  });
  if (!isCurrentRound(ctx, session, roundKey))
    throw new AppError("CEE_ROUND_CHANGED", "本局状态已变化");
  // 旧部署只有独立标签事件；新部署在猜测事务中登记并通过 ACK 确认。
  if (
    result.tagBanApplied !== true &&
    tags.length &&
    isCurrentRound(ctx, session, roundKey) &&
    session.phase === "guessing" &&
    ctx.chats.get(session.roomId)?.round?.phase === "guessing"
  ) {
    session.socket.emit("tagBanSharedMetaTags", { roomId: session.roomId, tags });
  }
  return result;
}

export function roundData(
  ctx: CEEOriginalContext,
  session: CEEOriginalSession
): CEEOriginalRoundData {
  if (!isCurrentRound(ctx, session)) throw new AppError("CEE_ROUND_CHANGED", "本局状态已变化");
  return ctx.chats.get(session.roomId)!.round!.data;
}

export function isCurrentRound(
  ctx: CEEOriginalContext,
  session: CEEOriginalSession,
  key = session.roundKey
): boolean {
  return (
    !session.revoked &&
    key !== null &&
    session.roundKey === key &&
    ctx.chats.get(session.roomId)?.round?.id === key
  );
}

export async function supplementAnswer(
  ctx: CEEOriginalContext,
  session: CEEOriginalSession
): Promise<CEECharacterView> {
  const key = session.roundKey;
  if (!session.answer) throw new AppError("CEE_ROUND_CHANGED", "本局状态已变化");
  const answer = await roundData(ctx, session).supplement(session.answer);
  if (!isCurrentRound(ctx, session, key)) throw new AppError("CEE_ROUND_CHANGED", "本局状态已变化");
  session.answer = answer;
  if (session.roundSummary) session.roundSummary.answer = answer;
  return answer;
}

export async function requestImageHint(
  ctx: CEEOriginalContext,
  session: CEEOriginalSession
): Promise<{ dataUrl: string }> {
  roundData(ctx, session);
  const state = originalPrivateState(session);
  if (!state.imageHintAvailable || !session.answer)
    throw new AppError("CEE_HINT_LOCKED", "图片提示尚未解锁");
  const roundKey = session.roundKey;
  const image =
    session.answer.imageUrl || (await ctx.options.data.resolveCharacterImage(session.answer.id));
  if (!image) throw new AppError("CEE_IMAGE_UNAVAILABLE", "暂时无法取得图片提示");
  const dataUrl = await ctx.imageHints.render(image, Math.max(1, state.imageHintLevel));
  if (!isCurrentRound(ctx, session, roundKey))
    throw new AppError("CEE_ROUND_CHANGED", "本局状态已变化");
  return { dataUrl };
}
