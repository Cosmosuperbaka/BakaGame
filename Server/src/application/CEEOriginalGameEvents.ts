import { createHash, randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import { buildCEEFeedback, createCEEHints } from "../domain/CEERules";
import {
  decodeOriginalCharacter,
  originalArray,
  originalCharacter,
  originalNumber,
  originalObject,
  originalPlayers,
  originalSettings,
  originalString,
  originalStrings,
} from "../infrastructure/CEEOriginalProtocol";
import type { CEEGuess } from "../shared/CEE";
import {
  cancelPreparation,
  publish,
  reasonOf,
  revoke,
  type CEEOriginalContext,
} from "./CEEOriginalContext";
import {
  applyOriginalEvent,
  ORIGINAL_EVENTS,
  type CEEOriginalEventHost,
} from "./CEEOriginalEvents";
import type { CEEOriginalSession } from "./CEEOriginalModel";
import { CEEOriginalRoundData } from "./CEEOriginalRoundData";
import {
  isCurrentRound,
  ownsPreparation,
  roundData,
  supplementAnswer,
} from "./CEEOriginalRoundFlow";

export function listenToUpstream(ctx: CEEOriginalContext, session: CEEOriginalSession): void {
  const host: CEEOriginalEventHost = {
    publish: (target, calibration) => publish(ctx, target, calibration),
    revoke: (target, reason, notify, kicked) => revoke(ctx, target, reason, notify, kicked),
    ownsPreparation: (target, operation) => ownsPreparation(ctx, target, operation),
    cancelPreparation: (target) => cancelPreparation(target),
    gameStarted: (target, payload) => gameStarted(ctx, target, payload),
    updateHistory: (target, value) => updateHistory(ctx, target, value),
    settleChatRound: (target) => {
      const round = ctx.chats.get(target.roomId)?.round;
      if (round?.id === target.roundKey) round.phase = "settled";
    },
    peersInRoom: (roomId) => [...ctx.sessions.values()].filter((peer) => peer.roomId === roomId),
  };
  for (const event of ORIGINAL_EVENTS) {
    session.socket.on(event, (value) => {
      try {
        applyOriginalEvent(event, session, value === undefined ? {} : originalObject(value), host);
        publish(ctx, session);
      } catch (error) {
        // 只记原因类别，不记载荷与密钥：区分密钥配错、载荷形状变化与其他异常。
        ctx.options.logger?.warn("原版房间状态转换失败", { event, reason: reasonOf(error) });
        revoke(ctx, session, "原版返回的房间状态无法解析，请重新加入");
      }
    });
  }
  session.socket.on("disconnect", () => revoke(ctx, session, "原版连接已中断，请重新加入房间"));
}

function gameStarted(
  ctx: CEEOriginalContext,
  session: CEEOriginalSession,
  payload: Record<string, unknown>
): void {
  const characterKey = createHash("sha256").update(JSON.stringify(payload.character)).digest("hex");
  const answer = decodeOriginalCharacter(payload.character, ctx.options.aesSecret!);
  const settings = originalSettings(payload.settings, session.settings.answerMode);
  if (!ctx.chats.has(session.roomId))
    ctx.chats.set(session.roomId, {
      generation: randomUUID(),
      chat: [],
      seenRoundKeys: new LRUCache({ max: 256 }),
    });
  const chat = ctx.chats.get(session.roomId)!;
  const previous = chat.round;
  const crossedEnd =
    previous?.phase === "settled" &&
    session.roundKey === previous.id &&
    session.phase !== "guessing";
  if (
    previous &&
    characterKey !== previous.characterKey &&
    chat.seenRoundKeys.has(characterKey) &&
    !crossedEnd
  )
    return;
  // 旧连接的快照只能追上已确认的新局，不能把共享房间退回旧载荷。
  if (
    previous &&
    session.roundKey &&
    session.roundKey !== previous.id &&
    characterKey !== previous.characterKey
  )
    return;
  const nextRound = !previous || characterKey !== previous.characterKey || crossedEnd;
  if (nextRound)
    chat.round = {
      id: randomUUID(),
      number: (previous?.number ?? 0) + 1,
      characterKey,
      phase: "guessing",
      hints: Array.isArray(payload.hints)
        ? originalStrings(payload.hints)
        : createCEEHints(answer.summary, settings.useHints.length, Math.random),
      data: new CEEOriginalRoundData(ctx.options.data),
    };
  const round = chat.round!;
  chat.seenRoundKeys.set(characterKey, round.number);
  const key = round.id;
  const isNew = session.roundKey !== key;
  session.settings = settings;
  session.answer = answer;
  cancelPreparation(session);
  delete session.choosingSetterFrom;
  session.phase = "guessing";
  session.setterId = null;
  session.players = originalPlayers(payload.players, session.phase, session.syncRound);
  if (typeof payload.isPublic === "boolean") session.isPublic = payload.isPublic;
  const me = session.players.find((player) => player.id === session.socket.id);
  if (me && payload.isAnswerSetter === true) me.isSetter = true;
  session.setterId = session.players.find((player) => player.isSetter)?.id || null;
  if (isNew) {
    session.roundNumber = round.number;
    session.syncRound = 1;
    session.roundKey = key;
    session.guesses = [];
    session.bannedTags.clear();
    session.winners = [];
    session.roundSummary = null;
    session.deadlineAt = null;
  }
  session.hints = round.hints;
  void supplementAnswer(ctx, session)
    .then(() => publish(ctx, session))
    .catch(() => {
      if (isCurrentRound(ctx, session, key))
        ctx.options.logger?.warn("原版答案附加标签读取失败", { roomId: session.roomId });
    });
}

function updateHistory(ctx: CEEOriginalContext, session: CEEOriginalSession, value: unknown): void {
  if (!session.answer) return;
  const previous = new Map(session.guesses.map((guess) => [guess.id, guess]));
  session.guesses = originalArray(value).flatMap((value) => {
    const history = originalObject(value);
    return originalArray(history.guesses).map((value, index): CEEGuess => {
      const raw = originalObject(value);
      const playerId =
        originalString(raw.playerId) ||
        session.players.find((player) => player.name === history.username)?.id ||
        "";
      const id = `${session.roundNumber}:${playerId}:${index}`;
      const existing = previous.get(id);
      if (existing) return existing;
      const character = originalCharacter(raw.guessData);
      const guess: CEEGuess = {
        id,
        playerId,
        playerName: originalString(raw.playerName) || originalString(history.username),
        character: {
          id: character.id,
          name: character.name,
          nameCn: character.nameCn,
          imageUrl: character.imageUrl,
        },
        correct: raw.isCorrect === true,
        partial: raw.isPartialCorrect === true,
        syncRound: originalNumber(raw.round, session.syncRound),
        createdAt: previous.get(id)?.createdAt || ctx.now(),
        feedback: buildCEEFeedback(character, session.answer!, session.settings),
      };
      const key = session.roundKey;
      if (!isCurrentRound(ctx, session, key)) return guess;
      void Promise.all([
        roundData(ctx, session).supplement(character),
        supplementAnswer(ctx, session),
      ])
        .then(([supplemented, answer]) => {
          if (!isCurrentRound(ctx, session, key) || !session.guesses.includes(guess)) return;
          const feedback = buildCEEFeedback(supplemented, answer, session.settings);
          guess.feedback = {
            ...guess.feedback,
            extraTags: feedback.extraTags,
            sharedAppearances: feedback.sharedAppearances,
          };
          publish(ctx, session);
        })
        .catch(() => {
          if (isCurrentRound(ctx, session, key))
            ctx.options.logger?.warn("原版猜测附加标签读取失败", { roomId: session.roomId });
        });
      return guess;
    });
  });
}
