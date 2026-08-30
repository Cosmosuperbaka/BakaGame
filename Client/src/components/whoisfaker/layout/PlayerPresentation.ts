import type { PlayerRole, PrivateState, PublicPlayerView } from "@/types";

export interface StatusInfo {
  label: string;
  tone: "default" | "emerald" | "violet" | "red" | "amber";
}

export function buildKnownRoleMap(
  players: PublicPlayerView[],
  privateState?: PrivateState | null,
  revealedRoles?: Map<string, PlayerRole>,
) {
  const roles = new Map(
    (privateState?.questionerView ?? []).map((entry) => [entry.playerId, entry.role]),
  );
  for (const player of players) {
    if (player.revealedRole) roles.set(player.id, player.revealedRole);
  }
  if (revealedRoles) {
    for (const [playerId, role] of revealedRoles) roles.set(playerId, role);
  }
  return roles;
}

export function resolveStatus(
  player: PublicPlayerView,
  waitingPhase: boolean,
  hideSpectatorStatus?: boolean,
): StatusInfo | null {
  if (player.roundStatus === "questioner") return { label: "主持", tone: "violet" };
  // 出局不占行首徽章位：它与房主、掉线一样是玩家的一种标记，
  // 统一放在名字之后的图标位，行首留给身份与阶段状态。
  if (player.roundStatus === "dead") return null;
  if (player.membership === "spectator") {
    return hideSpectatorStatus ? null : { label: "旁观", tone: "default" };
  }
  if (waitingPhase) {
    if (player.isReady) return { label: "准备", tone: "emerald" };
    return { label: "等待", tone: "default" };
  }
  return null;
}
