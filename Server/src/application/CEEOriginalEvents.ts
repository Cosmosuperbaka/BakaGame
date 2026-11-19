import { AppError } from "../domain/Errors";
import {
  originalArray,
  originalNumber,
  originalObject,
  originalPlayers,
  originalScores,
  originalSettings,
  originalString,
  originalStrings,
} from "../infrastructure/CEEOriginalProtocol";
import type { CEEOriginalPreparation, CEEOriginalSession } from "./CEEOriginalModel";

/** 原版事件处理需要的宿主动作面：全部由 `CEEOriginalService` 提供。 */
export interface CEEOriginalEventHost {
  publish(session: CEEOriginalSession, calibration?: boolean): void;
  revoke(session: CEEOriginalSession, reason: string, notify?: boolean, kicked?: boolean): void;
  ownsPreparation(session: CEEOriginalSession, operation: CEEOriginalPreparation): boolean;
  cancelPreparation(session: CEEOriginalSession): void;
  gameStarted(session: CEEOriginalSession, payload: Record<string, unknown>): void;
  updateHistory(session: CEEOriginalSession, value: unknown): void;
  /** 结算时把本地聊天侧的同轮回合同步置为已结算。 */
  settleChatRound(session: CEEOriginalSession): void;
  /** 与某会话同房的其余会话（roomClosed 时逐个吊销用）。 */
  peersInRoom(roomId: string): readonly CEEOriginalSession[];
}

/** 原版服务器会推的全部事件。 */
export const ORIGINAL_EVENTS = [
  "updatePlayers",
  "roomNameUpdated",
  "updateGameSettings",
  "waitForAnswer",
  "waitForAnswerCanceled",
  "gameStart",
  "guessHistoryUpdate",
  "resetTimer",
  "syncRoundStart",
  "syncWaiting",
  "tagBanStateUpdate",
  "nonstopProgress",
  "gameEnded",
  "playerKicked",
  "roomClosed",
] as const;

export type OriginalEvent = (typeof ORIGINAL_EVENTS)[number];

/**
 * 各事件的处理函数：只改 `session` 与调用宿主动作，不做发布（发布由统一的 on 包装负责）。
 * 抛错意味着原版状态无法解析，由调用方吊销会话。
 */
const handlers: {
  [E in OriginalEvent]: (
    session: CEEOriginalSession,
    payload: Record<string, unknown>,
    host: CEEOriginalEventHost
  ) => void;
} = {
  updatePlayers: (session, payload, host) => {
    session.players = originalPlayers(payload.players, session.phase, session.syncRound);
    if (typeof payload.isPublic === "boolean") session.isPublic = payload.isPublic;
    if (payload.answerSetterId !== undefined)
      session.setterId = originalString(payload.answerSetterId) || null;
    if (session.preparation && !host.ownsPreparation(session, session.preparation))
      host.cancelPreparation(session);
    if (session.confirmed && !session.players.some((player) => player.id === session.socket.id))
      host.revoke(session, "已离开原版房间", true, true);
  },
  roomNameUpdated: (session, payload) => {
    session.roomName = originalString(payload.roomName);
  },
  updateGameSettings: (session, payload, host) => {
    host.cancelPreparation(session);
    session.settings = originalSettings(payload.settings, session.settings.answerMode);
  },
  waitForAnswer: (session, payload, host) => {
    host.cancelPreparation(session);
    delete session.choosingSetterFrom;
    session.setterId = originalString(payload.answerSetterId);
    session.phase = "answering";
  },
  waitForAnswerCanceled: (session, _payload, host) => {
    host.cancelPreparation(session);
    delete session.choosingSetterFrom;
    session.setterId = null;
    session.phase = "waiting";
  },
  gameStart: (session, payload, host) => {
    host.gameStarted(session, payload);
  },
  guessHistoryUpdate: (session, payload, host) => {
    host.updateHistory(session, payload.guesses);
  },
  resetTimer: (session, payload) => {
    session.deadlineAt = originalNumber(payload.deadlineAt) || null;
  },
  syncRoundStart: (session, payload) => {
    session.syncRound = originalNumber(payload.round, 1);
    session.players.forEach((player) => {
      player.syncCompleted = false;
    });
  },
  syncWaiting: (session, payload) => {
    session.syncRound = originalNumber(payload.round, session.syncRound);
    const completed = new Set(
      originalArray(payload.syncStatus)
        .map(originalObject)
        .filter((item) => item.completed === true)
        .map((item) => originalString(item.id))
    );
    session.players.forEach((player) => {
      player.syncCompleted = completed.has(player.id);
    });
  },
  tagBanStateUpdate: (session, payload) => {
    session.bannedTags = new Map(
      originalArray(payload.tagBanState).map((value) => {
        const entry = originalObject(value);
        return [originalString(entry.tag), new Set(originalStrings(entry.revealer))];
      })
    );
  },
  nonstopProgress: (session, payload) => {
    session.winners = originalArray(payload.winners).map((value) => {
      const winner = originalObject(value);
      return {
        playerId: session.players.find((player) => player.name === winner.username)?.id || "",
        rank: originalNumber(winner.rank),
        score: originalNumber(winner.score),
      };
    });
  },
  gameEnded: (session, payload, host) => {
    if (!session.answer && session.roundKey === null) return;
    host.cancelPreparation(session);
    delete session.choosingSetterFrom;
    host.updateHistory(session, payload.guesses);
    session.phase = "settled";
    session.deadlineAt = null;
    if (!session.answer) throw new AppError("CEE_ORIGINAL_PROTOCOL", "缺少本局答案");
    const scores = originalScores(payload.scoreDetails, session.players);
    session.roundSummary = {
      answer: session.answer,
      scores,
      guesses: session.guesses,
      winners: session.winners.length
        ? session.winners
        : scores
            .filter((score) => score.base > 0)
            .map((score) => ({
              playerId: score.playerId,
              rank: score.rank || 1,
              score: score.score,
            })),
    };
    host.settleChatRound(session);
  },
  playerKicked: (session, payload, host) => {
    if (payload.playerId === session.socket.id)
      host.revoke(session, "已被房主移出原版房间", true, true);
  },
  roomClosed: (session, _payload, host) => {
    for (const peer of host.peersInRoom(session.roomId)) host.revoke(peer, "原版房间已关闭");
  },
};

export const applyOriginalEvent = (
  event: OriginalEvent,
  session: CEEOriginalSession,
  payload: Record<string, unknown>,
  host: CEEOriginalEventHost
): void => {
  handlers[event](session, payload, host);
};
