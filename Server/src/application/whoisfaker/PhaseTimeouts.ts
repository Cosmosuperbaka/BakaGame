import {
  ABSTAIN_TARGET_ID,
  type GameRound,
  type SpeechMode,
  type TieBreakStage,
  type WhoIsFakerPhase,
  type WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { timeoutBlankGuessPhase } from "./BlankGuess";
import { runBots } from "./dev/BotActors";
import { requeuePendingDisconnects } from "./PendingDisconnects";
import { clearPhaseTimer, completeSupplementIfReady } from "./PhaseTimers";
import { resolveNight, resolveVoting } from "./Resolution";
import { publishRoom } from "./RoomPublish";
import { finishRound } from "./RoundSettlement";
import {
  appendSpeech,
  getPendingActorIds,
  getPendingNightActors,
  getAliveAssignedPlayerIds,
  isTwoPlayerUndercoverEndgame,
} from "./RoundRules";
import type { WhoIsFakerContext } from "./Context";

/** 倒计时到点后按阶段强制推进：阶段 → 处理函数；未登记的阶段（如 feedback）不动作。 */
const phaseTimeoutHandlers: Partial<
  Record<
    WhoIsFakerPhase,
    (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord, round: GameRound) => Promise<void>
  >
> = {
  description: (ctx, room, round) => timeoutDescriptionPhase(ctx, room, round),
  voting: (ctx, room, round) => timeoutVotingPhase(ctx, room, round),
  tieBreak: (ctx, room, round) => timeoutTieBreakPhase(ctx, room, round),
  night: (ctx, room, round) => timeoutNightPhase(ctx, room, round),
  blankGuess: (ctx, room, round) => timeoutBlankGuessPhase(ctx, room, round),
};

export const handlePhaseTimeout = async (
  ctx: WhoIsFakerContext,
  roomId: string,
  expectedPhase: WhoIsFakerPhase,
  expectedSpeechMode?: SpeechMode,
  expectedTieBreakStage?: TieBreakStage
) => {
  const room = ctx.rooms.get(roomId);
  if (!room) return;

  const currentPhase = room.round?.phase ?? "waiting";
  if (currentPhase !== expectedPhase) return;
  if (room.round?.speechMode !== expectedSpeechMode) return;
  if (room.round?.tieBreak?.stage !== expectedTieBreakStage) return;

  clearPhaseTimer(ctx, room);
  ctx.appendSystemMessage(room, "本阶段倒计时结束，系统已强制推进");

  const round = room.round;
  if (!round) return;

  await phaseTimeoutHandlers[currentPhase]?.(ctx, room, round);
};

/**
 * 描述阶段超时：补充发言只补补充位，否则补完整轮描述后收口。
 * 只剩一卧一民时不再进投票，直接按卧底胜结算（见 `isTwoPlayerUndercoverEndgame`）。
 */
const timeoutDescriptionPhase = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<void> => {
  const supplement = round.supplement;
  if (supplement && round.speechMode === "supplement") {
    fillSupplementTimeouts(ctx, room, round, supplement);
  } else {
    fillDescriptionTimeouts(ctx, room, round);
    if (await settleTwoPlayerUndercoverEndgame(ctx, room, round)) return;
    round.phase = "voting";
    round.speechMode = undefined;
    round.votes = [];
  }
  ctx.touch(room);
  requeuePendingDisconnects(ctx, room);
  publishRoom(ctx, room);
  await runBots(ctx, room);
};

/** 2 人残局只剩一卧一民：按卧底胜结算并返回 true，调用方不再推进阶段。 */
const settleTwoPlayerUndercoverEndgame = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<boolean> => {
  if (!isTwoPlayerUndercoverEndgame(round)) return false;
  await finishRound(ctx, room, "undercover", "2人残局卧底胜");
  return true;
};

/** 描述超时的玩家按发言顺序补一条「（超时未发言）」，不让他们卡住整轮。 */
const fillDescriptionTimeouts = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): void => {
  for (const playerId of round.descriptionOrder) {
    if (!round.descriptionSubmittedBy.includes(playerId)) {
      const player = room.players[playerId] ?? { id: playerId, name: "超时玩家" };
      appendSpeech(ctx, round, player, "（超时未发言）", { kind: "description" });
    }
  }
};

/** 补充发言超时同样补位；补完即判这一轮补充是否已经齐了。 */
const fillSupplementTimeouts = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  supplement: NonNullable<GameRound["supplement"]>
): void => {
  for (const playerId of supplement.requestedPlayerIds) {
    if (!supplement.donePlayers.includes(playerId)) {
      const player = room.players[playerId] ?? { id: playerId, name: "超时玩家" };
      appendSpeech(ctx, round, player, "（超时未发言）", { kind: "supplement", supplement });
    }
  }
  completeSupplementIfReady(ctx, room);
};

/** 投票超时：活着的普通玩家（出题人除外）一律记一次弃权，交给正常计票收口。 */
const timeoutVotingPhase = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<void> => {
  for (const voterId of getPendingActorIds(round).filter((id) => id !== round.questionerPlayerId)) {
    round.votes.push({ voterId, targetId: ABSTAIN_TARGET_ID });
  }
  await resolveVoting(ctx, room, false);
  ctx.touch(room);
  publishRoom(ctx, room);
  await runBots(ctx, room);
};

/** 平票 PK 超时：发言段补位后转投票段；投票段同样记弃权后按 PK 计票收口。 */
const timeoutTieBreakPhase = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<void> => {
  const tieBreak = round.tieBreak;
  if (!tieBreak) return;

  if (tieBreak.stage === "description") {
    fillTieBreakTimeouts(ctx, room, round, tieBreak);
    tieBreak.stage = "vote";
    round.speechMode = undefined;
    tieBreak.votes = [];
    ctx.touch(room);
    requeuePendingDisconnects(ctx, room);
    publishRoom(ctx, room);
    await runBots(ctx, room);
    return;
  }

  if (tieBreak.stage === "vote") {
    const aliveIds = getAliveAssignedPlayerIds(ctx, room).filter(
      (id) => id !== round.questionerPlayerId
    );
    for (const voterId of aliveIds) {
      if (!tieBreak.votes.some((v) => v.voterId === voterId)) {
        tieBreak.votes.push({ voterId, targetId: ABSTAIN_TARGET_ID });
      }
    }
    await resolveVoting(ctx, room, true);
    ctx.touch(room);
    publishRoom(ctx, room);
    await runBots(ctx, room);
  }
};

/** PK 发言超时补位：只给没发言的候选人记一条「（超时未发言）」。 */
const fillTieBreakTimeouts = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  tieBreak: NonNullable<GameRound["tieBreak"]>
): void => {
  for (const candidateId of tieBreak.candidateIds) {
    if (!tieBreak.descriptionsDone.includes(candidateId)) {
      const player = room.players[candidateId] ?? { id: candidateId, name: "超时玩家" };
      appendSpeech(ctx, round, player, "（超时未发言）", { kind: "tieBreak", tieBreak });
    }
  }
};

/** 入夜超时：活着的平民与卧底一律记一次「未指定目标」的行动，再按正常夜晚收口。 */
const timeoutNightPhase = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound
): Promise<void> => {
  for (const { playerId, role } of getPendingNightActors(round)) {
    round.nightActions.push({ actorId: playerId, actorRole: role, targetId: undefined });
  }
  await resolveNight(ctx, room);
  ctx.touch(room);
  publishRoom(ctx, room);
  await runBots(ctx, room);
};
