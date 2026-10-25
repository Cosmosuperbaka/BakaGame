import type {
  SpeechMode,
  WhoIsFakerPrivateState,
  WhoIsFakerRoomSnapshot,
  PublicPlayerView,
} from "@bakagame/shared";

type Snapshot = WhoIsFakerRoomSnapshot;

const resolveSpeechMode = (status: Snapshot["status"]): SpeechMode =>
  status.speechMode ?? (status.phase === "tieBreak" ? "tieBreak" : "normal");

const selectSpeechOrder = (status: Snapshot["status"], mode: SpeechMode): readonly string[] => {
  if (status.speechOrder) return status.speechOrder;
  if (mode === "supplement") return status.pendingSupplementPlayerIds ?? [];
  if (mode === "tieBreak") return status.tieBreakCandidateIds ?? [];
  return status.descriptionOrder ?? [];
};

const submittedPlayerIds = (snapshot: Snapshot, mode: SpeechMode): Set<string> => {
  if (snapshot.status.submittedSpeechPlayerIds) {
    return new Set(snapshot.status.submittedSpeechPlayerIds);
  }
  const current = snapshot.descriptions.filter((description) => {
    if (mode === "tieBreak") {
      return (
        description.kind === "tieBreak" &&
        description.tieBreakIndex === snapshot.status.tieBreakIndex
      );
    }
    if (mode === "supplement") {
      return (
        description.kind === "supplement" &&
        description.supplementIndex === snapshot.status.supplementIndex
      );
    }
    return description.kind === "description" && description.cycle === snapshot.status.day;
  });
  return new Set(current.map((description) => description.playerId));
};

function canSpeak(
  snapshot: Snapshot,
  privateState: WhoIsFakerPrivateState,
  me: PublicPlayerView | undefined,
  mode: SpeechMode
): boolean {
  if (!me || me.roundStatus !== "alive" || privateState.isQuestioner) return false;
  const submitted = submittedPlayerIds(snapshot, mode);
  if (submitted.has(privateState.playerId)) return false;
  if (mode === "normal") return true;
  return selectSpeechOrder(snapshot.status, mode).includes(privateState.playerId);
}

function canVote(
  snapshot: Snapshot,
  privateState: WhoIsFakerPrivateState,
  me: PublicPlayerView | undefined
): boolean {
  if (!me || me.roundStatus !== "alive" || privateState.isQuestioner) return false;
  if (privateState.myCurrentVoteTargetId) return false;
  const isTieBreak = snapshot.status.phase === "tieBreak";
  const candidates = snapshot.status.tieBreakCandidateIds ?? [];
  return !isTieBreak || !candidates.includes(privateState.playerId);
}

/** 本地玩家当前是否有一项必须由自己发起的操作。恢复现场不算新提醒。 */
export function whoIsFakerNeedsAction(
  snapshot: Snapshot | null,
  privateState: WhoIsFakerPrivateState | null
): boolean {
  if (!snapshot || !privateState || privateState.mcpControlled) return false;
  const phase = snapshot.status.phase;
  const me = snapshot.players.find((player) => player.id === privateState.playerId);

  if (phase === "assigningQuestioner") return me?.isHost === true;
  if (phase === "wordSubmission") return privateState.isQuestioner;
  if (phase === "description") {
    return canSpeak(snapshot, privateState, me, resolveSpeechMode(snapshot.status));
  }
  if (phase === "tieBreak") {
    if (snapshot.status.tieBreakStage === "vote") return canVote(snapshot, privateState, me);
    return canSpeak(snapshot, privateState, me, "tieBreak");
  }
  if (phase === "voting") return canVote(snapshot, privateState, me);
  if (phase === "night") {
    return Boolean(
      me &&
      me.roundStatus === "alive" &&
      !privateState.isQuestioner &&
      (privateState.role === "civilian" || privateState.role === "undercover") &&
      !privateState.nightActionSubmitted
    );
  }
  if (phase === "blankGuess") {
    return privateState.canSubmitBlankGuess && snapshot.status.blankGuessPendingReview !== true;
  }
  if (phase === "feedback") return privateState.isQuestioner || snapshot.testMode;
  return false;
}
