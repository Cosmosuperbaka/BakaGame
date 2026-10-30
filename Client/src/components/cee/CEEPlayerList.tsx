import type { ReactNode, Ref } from "react";
import { useEffect, useRef } from "react";
import type { CEEPlayer, CEEPrivateState, CEERoomSnapshot } from "@bakagame/shared";
import { Check, Clock, X } from "lucide-react";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { Button } from "@/components/ui/Button";
import { PlayerRow, hostActions } from "@/components/common/PlayerRow";
import { AgentBadge, McpControlledBadge } from "@/components/common/AgentBadge";
import {
  PlayerGroupTitle,
  PlayerListLayout,
  PlayerStatusIcon,
  type PlayerStatusTone,
} from "@/components/common/PlayerStatusPill";
import { SpectatorToggle } from "@/components/common/SpectatorToggle";
import { usePlayerRowKeys } from "@/hooks/UsePlayerRowKeys";
import { TeamSection } from "@/components/common/TeamSection";
import { listContainer } from "@/lib/Motion";
import { teamGroups } from "@/lib/Teams";
import { useCEEAction } from "@/hooks/UseCEEAction";
import { useCEEStore } from "@/stores/UseCEEStore";
import {
  SPECTATE_APPROVAL_WATCHDOG_MS,
  SPECTATE_APPROVE_LABEL,
  SPECTATE_CANCEL_TEXT,
  SPECTATE_PENDING_TEXT,
  SPECTATE_REJECT_LABEL,
  SPECTATE_REQUEST_GROUP_TITLE,
  SPECTATE_TIMEOUT_TEXT,
} from "@/lib/AntiCheatCopy";
import { AnimatePresence, motion } from "framer-motion";
import { CEEMarks } from "@/components/common/CEEMarks";

/** 与 `useCEEAction` 的 `run` 同签名，避免玩家行各自重写命令类型。 */
type CEERun = ReturnType<typeof useCEEAction>["run"];

type CEEStatus = { label: string; tone: PlayerStatusTone };

const statuses: Record<CEEPlayer["status"], CEEStatus> = {
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
function resolveCEEStatus(player: CEEPlayer, snapshot: CEERoomSnapshot): CEEStatus | null {
  if (player.membership === "spectator") return null;
  if (snapshot.phase === "waiting" || snapshot.phase === "choosingSetter")
    return player.ready ? { label: "准备", tone: "success" } : { label: "等待", tone: "default" };
  if (snapshot.setterPlayerId === player.id) return { label: "出题", tone: "questioner" };
  // 结算后仍是「猜测中」的人就是本局没猜中的，不再挂进行中的警示色。
  if (snapshot.phase === "settled" && player.status === "playing")
    return { label: "未猜中", tone: "default" };
  return statuses[player.status];
}

export function CEEPlayerList({
  snapshot,
  privateState,
}: {
  snapshot: CEERoomSnapshot;
  privateState: CEEPrivateState;
}) {
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const waiting = snapshot.phase === "waiting";
  const { run, busy } = useCEEAction();
  const activePlayers = snapshot.players.filter((player) => player.membership === "active");
  const observers = snapshot.players.filter((player) => player.membership === "spectator");
  const groups = teamGroups(activePlayers);
  // 换组（含换队）后 key 随之变化，来回切换时不会复活还在退场的旧行（见 usePlayerRowKeys）。
  const rowKey = usePlayerRowKeys(
    snapshot.players.map((player) => ({
      id: player.id,
      group: player.membership === "active" ? `active:${player.team ?? "solo"}` : player.membership,
    }))
  );
  const teamed = groups.some((group) => group.team !== null);
  // 两种来源都只在等待阶段改身份；已在旁观的人即使房间后来关了观战，也要能回到玩家组。
  const canJoinSpectators = waiting && snapshot.allowSpectators && me?.membership === "active";
  const canJoinPlayers = waiting && me?.membership === "spectator";
  const toggleSpectator = (spectator: boolean) => void run("cee.player.spectate", { spectator });

  // 反作弊房：旁观要先经房主批准。待批准期间本人既不在玩家组也不在旁观组，单独显示等待状态。
  const pendingMe = me?.membership === "pendingSpectator";
  const pendingRequests = isHost ? snapshot.spectateRequests : [];

  // 服务端按 120 秒兜底回收请求、但不给被超时退回的一方发事件；这里挂一个看门狗，
  // 到点仍未批准就补一条超时提示（批准/拒绝会先到并清掉计时器，多留的余量避开与快照竞争）。
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!pendingMe) return;
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = setTimeout(
      () => useCEEStore.getState().showToast(SPECTATE_TIMEOUT_TEXT, "error"),
      SPECTATE_APPROVAL_WATCHDOG_MS
    );
    return () => {
      if (watchdog.current) clearTimeout(watchdog.current);
      watchdog.current = null;
    };
  }, [pendingMe]);

  const renderRows = (players: CEEPlayer[], inTeam: boolean) => (
    <motion.div
      className="flex flex-col gap-px"
      variants={listContainer(players.length)}
      initial={false}
      animate="animate"
    >
      <AnimatePresence initial={false} mode="popLayout">
        {players.map((player) => (
          <CEEPlayerRow
            key={rowKey(player.id)}
            player={player}
            snapshot={snapshot}
            sharedInHeader={
              inTeam &&
              snapshot.phase === "guessing" &&
              sharedProgress(players) !== null &&
              player.status !== "observing"
            }
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
        <div className="flex min-w-0 flex-col px-2 py-1.5">
          <PlayerGroupTitle label="玩家" count={activePlayers.length} />
          {teamed ? (
            // 有人组队时按队伍分块：队伍一块带标题与共享进度，个人游玩的人接在最后、不加底。
            <div className="flex flex-col gap-1">
              <AnimatePresence initial={false}>
                {groups.map(({ team, members }) => (
                  <CEETeamSection
                    key={team ?? "solo"}
                    team={team}
                    members={members}
                    snapshot={snapshot}
                  >
                    {renderRows(members, team !== null)}
                  </CEETeamSection>
                ))}
              </AnimatePresence>
            </div>
          ) : (
            renderRows(activePlayers, false)
          )}
          {canJoinPlayers ? (
            <SpectatorToggle spectator={false} disabled={busy} onToggle={toggleSpectator} />
          ) : null}

          {observers.length > 0 || canJoinSpectators || pendingMe ? (
            <>
              <PlayerGroupTitle label="旁观" count={observers.length} withRule />
              {renderRows(observers, false)}
              {canJoinSpectators ? (
                <SpectatorToggle spectator disabled={busy} onToggle={toggleSpectator} />
              ) : null}
              {pendingMe ? (
                <div className="mt-1 flex min-w-0 items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      {me?.name ? `${me.name}：` : ""}
                      {SPECTATE_PENDING_TEXT}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
                    disabled={busy}
                    onClick={() => toggleSpectator(false)}
                  >
                    {SPECTATE_CANCEL_TEXT}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}

          {isHost && pendingRequests.length > 0 ? (
            <>
              <PlayerGroupTitle
                label={SPECTATE_REQUEST_GROUP_TITLE}
                count={pendingRequests.length}
                withRule
              />
              <div className="flex flex-col gap-px">
                {pendingRequests.map((request) => (
                  <div
                    key={request.playerId}
                    className="flex min-w-0 items-center justify-between gap-2 py-1"
                  >
                    <span className="min-w-0 truncate text-sm">{request.name}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 px-2 text-xs"
                        disabled={busy}
                        onClick={() =>
                          void run("cee.player.approveSpectate", {
                            playerId: request.playerId,
                            approved: true,
                          })
                        }
                        data-agent-control={`cee.spectate.approve.${request.playerId}`}
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        {SPECTATE_APPROVE_LABEL}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
                        disabled={busy}
                        aria-label={`${SPECTATE_REJECT_LABEL} ${request.name}`}
                        onClick={() =>
                          void run("cee.player.approveSpectate", {
                            playerId: request.playerId,
                            approved: false,
                          })
                        }
                        data-agent-control={`cee.spectate.reject.${request.playerId}`}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                        {SPECTATE_REJECT_LABEL}
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
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
function sharedProgress(members: CEEPlayer[]): CEEPlayer | null {
  const guessing = members.filter((player) => player.status !== "observing");
  const [first] = guessing;
  if (!first) return null;
  return guessing.every(
    (player) =>
      player.attempts === first.attempts &&
      player.marks === first.marks &&
      player.syncCompleted === first.syncCompleted
  )
    ? first
    : null;
}

/**
 * 队伍块：标题行给队号、人数与全队合计分（见 `TeamSection`）。
 * 猜测阶段共享的次数、同步提交与进度只在标题出现一次，不在每个队员行重复。
 */
function CEETeamSection({
  ref,
  team,
  members,
  snapshot,
  children,
}: {
  ref?: Ref<HTMLElement>;
  team: number | null;
  members: CEEPlayer[];
  snapshot: CEERoomSnapshot;
  children: ReactNode;
}) {
  const shared = team !== null && snapshot.phase === "guessing" ? sharedProgress(members) : null;
  const detail = [
    `${members.length} 人`,
    shared ? `${shared.attempts}/${snapshot.settings.maxAttempts} 次` : null,
    shared && snapshot.settings.syncMode && shared.syncCompleted ? "已提交" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <TeamSection
      ref={ref}
      team={team}
      scores={members.map((player) => player.score)}
      detail={detail}
      extra={shared?.marks ? <CEEMarks marks={shared.marks} name={`${team} 队`} /> : null}
    >
      {children}
    </TeamSection>
  );
}

interface CEEPlayerRowProps {
  ref?: Ref<HTMLDivElement>;
  player: CEEPlayer;
  snapshot: CEERoomSnapshot;
  /** 次数、同步提交与进度已由队伍标题给出，行内不再重复 */
  sharedInHeader: boolean;
  self: boolean;
  canManage: boolean;
  busy: boolean;
  /** 与 `useCEEAction` 的 `run` 同签名，避免每个玩家行各自重写命令类型。 */
  run: CEERun;
}

function CEEPlayerRow({
  ref,
  player,
  snapshot,
  sharedInHeader,
  self,
  canManage,
  busy,
  run,
}: CEEPlayerRowProps) {
  const status = resolveCEEStatus(player, snapshot);
  const progress =
    !sharedInHeader && snapshot.phase === "guessing" && player.status !== "observing";
  const detail = [
    progress ? `${player.attempts}/${snapshot.settings.maxAttempts} 次` : null,
    progress && snapshot.settings.syncMode && player.syncCompleted ? "已提交" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const actions = canManage
    ? hostActions({
        onTransferHost: () => void run("cee.room.transferHost", { playerId: player.id }),
        // 无席位的旁观者接不了房主，掉线时命令会失败；保留动作并禁用，比直接隐藏更好读。
        transferDisabled: busy || !player.online || player.membership !== "active",
        onKick: () => void run("cee.room.kick", { playerId: player.id }),
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
      account={player.account}
      badges={
        <>
          {player.isAgent ? <AgentBadge /> : null}
          {player.mcpControlled ? <McpControlledBadge /> : null}
          {status ? <PlayerStatusIcon {...status} /> : null}
        </>
      }
      meta={
        detail ? (
          <span className="truncate font-sans text-2xs text-muted-foreground">{detail}</span>
        ) : null
      }
      detail={
        !sharedInHeader && player.marks ? (
          <CEEMarks marks={player.marks} name={player.name} />
        ) : null
      }
      actions={actions}
      layoutId={player.id}
      ref={ref}
    />
  );
}
