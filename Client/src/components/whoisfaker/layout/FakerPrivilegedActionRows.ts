import { ABSTAIN_TARGET_ID } from "@bakagame/shared/values";
import type {
  WhoIsFakerPrivateState,
  WhoIsFakerRole,
  WhoIsFakerRoomSnapshot,
} from "@bakagame/shared";

type QuestionerView = NonNullable<WhoIsFakerPrivateState["questionerView"]>;
type ActionPreview = NonNullable<WhoIsFakerPrivateState["privilegedActionPreview"]>;

/** 预览表的一行：谁、身份、当前选择（或还在等）。 */
export interface PreviewRow {
  id: string;
  name: string;
  role?: WhoIsFakerRole;
  value: string;
  pending: boolean;
}

const UNKNOWN_PLAYER = "未知玩家";

/** 平票 PK 里候选人本人不投票，其余存活者都要投。 */
function eligibleVoters(snapshot: WhoIsFakerRoomSnapshot) {
  const candidates = snapshot.status.tieBreakCandidateIds ?? [];
  return snapshot.players.filter(
    (player) =>
      player.roundStatus === "alive" &&
      !(snapshot.status.phase === "tieBreak" && candidates.includes(player.id))
  );
}

/** 投票预览：每位该投票的存活者投给了谁，没投的显示等待。 */
export function buildVoteRows(
  snapshot: WhoIsFakerRoomSnapshot,
  questionerView: QuestionerView,
  preview: ActionPreview
): PreviewRow[] {
  const names = new Map(snapshot.players.map((player) => [player.id, player.name]));
  const roles = new Map(questionerView.map((player) => [player.playerId, player.role]));
  return eligibleVoters(snapshot).map((player) => {
    const vote = preview.votes.find((item) => item.voterId === player.id);
    const choice = !vote
      ? "等待投票"
      : vote.targetId === ABSTAIN_TARGET_ID
        ? "弃票"
        : (names.get(vote.targetId) ?? UNKNOWN_PLAYER);
    return {
      id: player.id,
      name: player.name,
      role: roles.get(player.id),
      value: choice,
      pending: !vote,
    };
  });
}

/** 夜晚预览：只列存活的平民与卧底（天使、白板夜里没有行动）。 */
export function buildNightRows(
  snapshot: WhoIsFakerRoomSnapshot,
  questionerView: QuestionerView,
  preview: ActionPreview
): PreviewRow[] {
  const names = new Map(snapshot.players.map((player) => [player.id, player.name]));
  return questionerView
    .filter(
      (player) => player.alive && (player.role === "civilian" || player.role === "undercover")
    )
    .map((player) => {
      const action = preview.nightActions.find((item) => item.actorId === player.playerId);
      const choice = !action
        ? "等待行动"
        : action.targetId
          ? (names.get(action.targetId) ?? UNKNOWN_PLAYER)
          : "无行动";
      return {
        id: player.playerId,
        name: names.get(player.playerId) ?? UNKNOWN_PLAYER,
        role: player.role,
        value: choice,
        pending: !action,
      };
    });
}

/** 票数统计的目标集合：平票 PK 只列候选人。 */
export function voteTargetsOf(snapshot: WhoIsFakerRoomSnapshot) {
  const alive = snapshot.players.filter((player) => player.roundStatus === "alive");
  const candidates = snapshot.status.tieBreakCandidateIds ?? [];
  return snapshot.status.phase === "tieBreak" && candidates.length > 0
    ? alive.filter((player) => candidates.includes(player.id))
    : alive;
}

/** 每个目标得几票，弃票也计在内（以 ABSTAIN_TARGET_ID 为键）。 */
export function countVotes(votes: ActionPreview["votes"]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const vote of votes) counts.set(vote.targetId, (counts.get(vote.targetId) ?? 0) + 1);
  return counts;
}
