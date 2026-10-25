import type { SonGuessrPrivateState, SonGuessrRoomSnapshot } from "@bakagame/shared";

/** 本地玩家当前是否有一项必须由自己发起的操作。恢复现场不算新提醒。 */
export function sonGuessrNeedsAction(
  snapshot: SonGuessrRoomSnapshot | null,
  privateState: SonGuessrPrivateState | null
): boolean {
  if (!snapshot || !privateState || privateState.mcpControlled) return false;
  if (snapshot.phase === "submittingSong") return privateState.canSubmitSong;
  if (snapshot.phase === "playing") return privateState.canGuess;
  if (snapshot.phase === "choosingSubmitter") {
    return (
      snapshot.hostPlayerId === privateState.playerId &&
      privateState.submitterCandidateIds.length > 0
    );
  }
  return false;
}
