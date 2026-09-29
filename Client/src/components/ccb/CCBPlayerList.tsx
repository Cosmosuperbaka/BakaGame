import type { CCBPlayer, CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { PlayerRow, hostActions } from "@/components/common/PlayerRow";
import { PlayerGroupTitle, PlayerStatusPill, type PlayerStatusTone } from "@/components/common/PlayerStatusPill";
import { SpectatorToggle } from "@/components/common/SpectatorToggle";
import { listContainer } from "@/lib/Motion";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { AnimatePresence, motion } from "framer-motion";
import { CCBMarks } from "./CCBMarks";
import { CCBSelect } from "./CCBSelect";

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
  if (snapshot.phase === "waiting") return player.ready ? { label: "准备", tone: "success" } : { label: "等待", tone: "default" };
  if (snapshot.setterPlayerId === player.id) return { label: "出题", tone: "questioner" };
  return statuses[player.status];
}

export function CCBPlayerList({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const waiting = snapshot.phase === "waiting";
  const { run, busy } = useCCBAction();
  const activePlayers = snapshot.players.filter((player) => player.membership === "active");
  const observers = snapshot.players.filter((player) => player.membership === "spectator");
  // 两种来源都只在等待阶段改身份；已在旁观的人即使房间后来关了观战，也要能回到玩家组。
  const canJoinSpectators = waiting && snapshot.allowSpectators && me?.membership === "active";
  const canJoinPlayers = waiting && me?.membership === "spectator";
  const toggleSpectator = (spectator: boolean) => void run("ccb.player.spectate", { spectator });

  const renderGroup = (players: CCBPlayer[]) => (
    <motion.div
      className="flex flex-col gap-px"
      variants={listContainer(players.length)}
      initial={false}
      animate="animate"
    >
      <AnimatePresence initial={false}>
        {players.map((player) => (
          <CCBPlayerRow
            key={player.id}
            player={player}
            snapshot={snapshot}
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
      <div className="flex min-w-0 flex-col px-2 py-3">
        <PlayerGroupTitle label="玩家" count={activePlayers.length} />
        {renderGroup(activePlayers)}
        {canJoinPlayers ? <SpectatorToggle spectator={false} disabled={busy} onToggle={toggleSpectator} /> : null}

        {observers.length > 0 || canJoinSpectators ? (
          <>
            <PlayerGroupTitle label="旁观" count={observers.length} withRule />
            {renderGroup(observers)}
            {canJoinSpectators ? <SpectatorToggle spectator disabled={busy} onToggle={toggleSpectator} /> : null}
          </>
        ) : null}

        {/* 组队是 CCB 独有的设置，放在两个分组之后，不和旁观切换混在一起。 */}
        {waiting && me?.membership === "active" ? (
          <div className="mt-3 border-t pt-3">
            <CCBSelect
              label="我的队伍"
              value={me.team === null ? "solo" : String(me.team)}
              options={[
                { value: "solo", label: "个人游玩" },
                ...Array.from({ length: 8 }, (_, index) => ({ value: String(index + 1), label: `第 ${index + 1} 队` })),
              ]}
              disabled={busy}
              onChange={(value) => void run("ccb.player.team", { team: value === "solo" ? null : Number(value) })}
            />
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}

interface CCBPlayerRowProps {
  player: CCBPlayer;
  snapshot: CCBRoomSnapshot;
  self: boolean;
  canManage: boolean;
  busy: boolean;
  /** 与 `useCCBAction` 的 `run` 同签名，避免每个玩家行各自重写命令类型。 */
  run: CCBRun;
}

function CCBPlayerRow({ player, snapshot, self, canManage, busy, run }: CCBPlayerRowProps) {
  const status = resolveCCBStatus(player, snapshot);
  const progress = snapshot.phase === "guessing" && player.status !== "observing";
  const detail = [
    player.team !== null ? `${player.team} 队` : null,
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
      meta={detail ? <span className="truncate font-sans text-[11px] text-muted-foreground">{detail}</span> : null}
      detail={player.marks ? <CCBMarks marks={player.marks} name={player.name} /> : null}
      actions={actions}
    />
  );
}
