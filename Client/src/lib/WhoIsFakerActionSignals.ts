import { getPageControl } from "@/stores/UsePageControl";
import type {
  SpeechMode,
  WhoIsFakerPrivateState,
  WhoIsFakerRoomSnapshot,
  PublicPlayerView,
} from "@bakagame/shared";
import { speechModeOf, speechOrderOf, submittedOf } from "@/lib/WhoIsFakerSpeech";

type Snapshot = WhoIsFakerRoomSnapshot;

function canSpeak(
  snapshot: Snapshot,
  privateState: WhoIsFakerPrivateState,
  me: PublicPlayerView | undefined,
  mode: SpeechMode
): boolean {
  if (!me || me.roundStatus !== "alive" || privateState.isQuestioner) return false;
  if (submittedOf(snapshot.status).has(privateState.playerId)) return false;
  if (mode === "normal") return true;
  return speechOrderOf(snapshot.status).includes(privateState.playerId);
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
  if (!snapshot || !privateState || getPageControl().status === "controlled") return false;
  const phase = snapshot.status.phase;
  const me = snapshot.players.find((player) => player.id === privateState.playerId);

  if (phase === "assigningQuestioner") return me?.isHost === true;
  if (phase === "wordSubmission") return privateState.isQuestioner;
  if (phase === "description") {
    return canSpeak(snapshot, privateState, me, speechModeOf(snapshot.status));
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
      privateState.canActAtNight &&
      !privateState.nightActionSubmitted
    );
  }
  if (phase === "blankGuess") {
    return privateState.canSubmitBlankGuess && snapshot.status.blankGuessPendingReview !== true;
  }
  if (phase === "feedback") return privateState.isQuestioner || snapshot.testMode;
  return false;
}
