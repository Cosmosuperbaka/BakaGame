import type { Ref } from "react";
import type { CCBPlayer, CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { PlayerRow, hostActions } from "@/components/common/PlayerRow";
import { PlayerGroupTitle, PlayerListLayout, PlayerStatusPill, type PlayerStatusTone } from "@/components/common/PlayerStatusPill";
import { SpectatorToggle } from "@/components/common/SpectatorToggle";
import { usePlayerRowKeys } from "@/hooks/UsePlayerRowKeys";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { listContainer, listItem, playerRelayout } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { AnimatePresence, motion } from "framer-motion";
import { CCBMarks } from "./CCBMarks";

/** 与 `useCCBAction` 的 `run` 同签名，避免玩家行各自重写命令类型。 */
type CCBRun = ReturnType<typeof useCCBAction>["run"];

type CCBStatus = { label: string; tone: PlayerStatusTone };

const statuses: Record<CCBPlayer["status"], CCBStatus> = {
  waiting: { label: "等待", tone: "default" },
  playing: { label: "猜测中", tone: "warning" },
  solved: { label: "猜中", tone: "success" },
  teamWon: { label: "队伍获胜", tone: "success" },
  exhausted: { label: "次数用尽", tone: "default" },
  surrendered: { label: "已放弃", tone: "default" },
  observing: { label: "旁观", tone: "default" },
};

/**
 * 与另外两个游戏同一口径：旁观分组不重复「旁观」，等待阶段表达准备状态；
 * 开局后服务端把出题人记为观战，这里按 `setterPlayerId` 标成「出题」，其余取本局行动状态。
 */
function resolveCCBStatus(player: CCBPlayer, snapshot: CCBRoomSnapshot): CCBStatus | null {
  if (player.membership === "spectator") return null;
  if (snapshot.phase === "waiting" || snapshot.phase === "choosingSetter") return player.ready ? { label: "准备", tone: "success" } : { label: "等待", tone: "default" };
  if (snapshot.setterPlayerId === player.id) return { label: "出题", tone: "questioner" };
  // 结算后仍是「猜测中」的人就是本局没猜中的，不再挂进行中的警示色。
  if (snapshot.phase === "settled" && player.status === "playing") return { label: "未猜中", tone: "default" };
  return statuses[player.status];
}

/** 参与者按队伍分组：队伍按队号升序在前，个人游玩的人在后；组内保持服务端座次。 */
function teamGroups(players: CCBPlayer[]): Array<{ team: number | null; members: CCBPlayer[] }> {
  const groups = new Map<number | null, CCBPlayer[]>();
  for (const player of players) groups.set(player.team, [...(groups.get(player.team) ?? []), player]);
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([team, members]) => ({ team, members }));
}

export function CCBPlayerList({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const waiting = snapshot.phase === "waiting";
  const { run, busy } = useCCBAction();
  const activePlayers = snapshot.players.filter((player) => player.membership === "active");
  const observers = snapshot.players.filter((player) => player.membership === "spectator");
  const groups = teamGroups(activePlayers);
  // 换组（含换队）后 key 随之变化，来回切换时不会复活还在退场的旧行（见 usePlayerRowKeys）。
  const rowKey = usePlayerRowKeys(snapshot.players.map((player) => ({
    id: player.id,
    group: player.membership === "active" ? `active:${player.team ?? "solo"}` : player.membership,
  })));
  const teamed = groups.some((group) => group.team !== null);
  // 两种来源都只在等待阶段改身份；已在旁观的人即使房间后来关了观战，也要能回到玩家组。
  const canJoinSpectators = waiting && snapshot.allowSpectators && me?.membership === "active";
  const canJoinPlayers = waiting && me?.membership === "spectator";
  const toggleSpectator = (spectator: boolean) => void run("ccb.player.spectate", { spectator });

  const renderRows = (players: CCBPlayer[], inTeam: boolean) => (
    <motion.div className="flex flex-col gap-px" variants={listContainer(players.length)} initial={false} animate="animate">
      <AnimatePresence initial={false} mode="popLayout">
        {players.map((player) => (
          <CCBPlayerRow
            key={rowKey(player.id)}
            player={player}
            snapshot={snapshot}
            sharedInHeader={inTeam && snapshot.phase === "guessing" && sharedProgress(players) !== null && player.status !== "observing"}
            self={player.id === privateState.playerId}
            canManage={isHost && player.id !== privateState.playerId}
            busy={busy}
            run={run}
          />
        ))}
      </AnimatePresence>
    </motion.div>
  );

  return (
    <ScrollArea className="h-full">
      <PlayerListLayout>
        <div className="flex min-w-0 flex-col px-2 py-3">
          <PlayerGroupTitle label="玩家" count={activePlayers.length} />
          {teamed ? (
            // 有人组队时按队伍分块：队伍一块带标题与共享进度，个人游玩的人接在最后、不加底。
            <div className="flex flex-col gap-1.5">
              <AnimatePresence initial={false}>
                {groups.map(({ team, members }) => (
                  <motion.section
                    key={team ?? "solo"}
                    variants={listItem}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    layout="position"
                    transition={playerRelayout}
                    aria-label={team === null ? "个人游玩" : `${team} 队`}
                    className={cn("min-w-0", team !== null && "rounded-md bg-muted/40 p-0.5")}
                  >
                    <CCBTeamHeader team={team} members={members} snapshot={snapshot} />
                    {renderRows(members, team !== null)}
                  </motion.section>
                ))}
              </AnimatePresence>
            </div>
          ) : renderRows(activePlayers, false)}
          {canJoinPlayers ? <SpectatorToggle spectator={false} disabled={busy} onToggle={toggleSpectator} /> : null}

          {observers.length > 0 || canJoinSpectators ? (
            <>
              <PlayerGroupTitle label="旁观" count={observers.length} withRule />
              {renderRows(observers, false)}
              {canJoinSpectators ? <SpectatorToggle spectator disabled={busy} onToggle={toggleSpectator} /> : null}
            </>
          ) : null}
        </div>
      </PlayerListLayout>
    </ScrollArea>
  );
}

/**
 * 队伍共用的那份进度：增强房同队共享次数与猜测记录，队员的次数与进度串完全相同；原版房的进度逐人来自上游，未必一致。
 * 仍在猜的队员（出题人队友本局观战，不算）记录一致时返回其中一人，由队伍标题统一展示，否则返回 null、留在各自行里。
 */
function sharedProgress(members: CCBPlayer[]): CCBPlayer | null {
  const guessing = members.filter((player) => player.status !== "observing");
  const [first] = guessing;
  if (!first) return null;
  return guessing.every((player) => player.attempts === first.attempts && player.marks === first.marks && player.syncCompleted === first.syncCompleted)
    ? first : null;
}

/**
 * 队伍块的标题行：队号、人数与全队合计分。分数仍按人存储（离队后个人分保留），这里只是相加。
 * 猜测阶段共享的次数、同步提交与进度只在这里出现一次，不在每个队员行重复。
 */
function CCBTeamHeader({ team, members, snapshot }: { team: number | null; members: CCBPlayer[]; snapshot: CCBRoomSnapshot }) {
  if (team === null) {
    return <p className="px-2 pt-1 pb-0.5 font-sans text-2xs text-muted-foreground">个人</p>;
  }
  const total = members.reduce((sum, player) => sum + player.score, 0);
  const shared = snapshot.phase === "guessing" ? sharedProgress(members) : null;
  const detail = [
    `${members.length} 人`,
    shared ? `${shared.attempts}/${snapshot.settings.maxAttempts} 次` : null,
    shared && snapshot.settings.syncMode && shared.syncCompleted ? "已提交" : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className="space-y-0.5 px-2 pt-1 pb-0.5">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="text-xs font-medium">{team} 队</span>
        <span className="min-w-0 flex-1 truncate font-sans text-2xs text-muted-foreground">{detail}</span>
        <span aria-label={`合计 ${total} 分`} className="flex shrink-0 items-baseline gap-0.5 font-sans text-2xs text-muted-foreground tabular-nums">
          合计<AnimatedNumber value={total} className="text-xs text-foreground" />分
        </span>
      </div>
      {shared?.marks ? <CCBMarks marks={shared.marks} name={`${team} 队`} /> : null}
    </div>
  );
}

interface CCBPlayerRowProps {
  ref?: Ref<HTMLDivElement>;
  player: CCBPlayer;
  snapshot: CCBRoomSnapshot;
  /** 次数、同步提交与进度已由队伍标题给出，行内不再重复 */
  sharedInHeader: boolean;
  self: boolean;
  canManage: boolean;
  busy: boolean;
  /** 与 `useCCBAction` 的 `run` 同签名，避免每个玩家行各自重写命令类型。 */
  run: CCBRun;
}

function CCBPlayerRow({ ref, player, snapshot, sharedInHeader, self, canManage, busy, run }: CCBPlayerRowProps) {
  const status = resolveCCBStatus(player, snapshot);
  const progress = !sharedInHeader && snapshot.phase === "guessing" && player.status !== "observing";
  const detail = [
    progress ? `${player.attempts}/${snapshot.settings.maxAttempts} 次` : null,
    progress && snapshot.settings.syncMode && player.syncCompleted ? "已提交" : null,
  ].filter(Boolean).join(" · ");

  const actions = canManage
    ? hostActions({
        onTransferHost: () => void run("ccb.room.transferHost", { playerId: player.id }),
        // 无席位的旁观者接不了房主，掉线时命令会失败；保留动作并禁用，比直接隐藏更好读。
        transferDisabled: busy || !player.online || player.membership !== "active",
        onKick: () => void run("ccb.room.kick", { playerId: player.id }),
        kickDisabled: busy,
      })
    : undefined;

  return (
    <PlayerRow
      name={player.name}
      score={player.score}
      me={self}
      host={snapshot.hostPlayerId === player.id}
      online={player.online}
      badges={status ? <PlayerStatusPill {...status} /> : null}
      meta={detail ? <span className="truncate font-sans text-2xs text-muted-foreground">{detail}</span> : null}
      detail={!sharedInHeader && player.marks ? <CCBMarks marks={player.marks} name={player.name} /> : null}
      actions={actions}
      layoutId={player.id}
      ref={ref}
    />
  );
}
