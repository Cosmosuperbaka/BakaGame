/** 协议允许的队伍号 1–8（CCB 与猜歌一致）；null 是个人游玩，排在首格。 */
export const TEAM_OPTIONS: Array<number | null> = [null, 1, 2, 3, 4, 5, 6, 7, 8];

export const teamKey = (team: number | null) => (team === null ? "solo" : String(team));
export const teamLabel = (team: number | null) => (team === null ? "个人" : `${team} 队`);

/** 参与者按队伍分组：队伍按队号升序在前，个人游玩的人在后；组内保持服务端座次。 */
export function teamGroups<T extends { team: number | null }>(players: T[]): Array<{ team: number | null; members: T[] }> {
  const groups = new Map<number | null, T[]>();
  for (const player of players) groups.set(player.team, [...(groups.get(player.team) ?? []), player]);
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([team, members]) => ({ team, members }));
}

/** 候选名后带上队伍：指定出题人后整队本局观战，房主选人时要看得见。 */
export const withTeamName = (player: { id: string; name: string; team: number | null }) =>
  ({ id: player.id, name: player.team !== null ? `${player.name}（${player.team} 队）` : player.name });
