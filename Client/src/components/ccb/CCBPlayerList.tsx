import type { CCBPlayer, CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { PlayerRow, hostActions } from "@/components/common/PlayerRow";
import { PlayerGroupTitle, PlayerStatusPill, type PlayerStatusTone } from "@/components/common/PlayerStatusPill";
import { listContainer } from "@/lib/Motion";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { AnimatePresence, motion } from "framer-motion";
import { CCBMarks } from "./CCBMarks";
import { CCBSelect } from "./CCBSelect";

/** 与 `useCCBAction` 的 `run` 同签名，避免player row 各自重写命令类型。 */
type CCBRun = ReturnType<typeof useCCBAction>["run"];

const statuses: Record<CCBPlayer["status"], { label: string; tone: PlayerStatusTone }> = {
  waiting: { label: "等待", tone: "default" },
  playing: { label: "猜测中", tone: "warning" },
  solved: { label: "猜中", tone: "success" },
  teamWon: { label: "队伍获胜", tone: "success" },
  exhausted: { label: "次数用尽", tone: "default" },
  surrendered: { label: "已放弃", tone: "default" },
  observing: { label: "旁观", tone: "default" },
};

export function CCBPlayerList({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const waiting = snapshot.phase === "waiting";
  const { run, busy } = useCCBAction();

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col px-2 py-3">
        {(["active", "spectator"] as const).map((membership, groupIndex) => {
          const players = snapshot.players.filter((player) => player.membership === membership);
          return (
            <section key={membership} className="flex min-w-0 flex-col">
              <PlayerGroupTitle
                label={membership === "active" ? "玩家" : "旁观"}
                count={players.length}
                withRule={groupIndex > 0}
              />
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
                      waiting={waiting}
                      membership={membership}
                      busy={busy}
                      run={run}
                    />
                  ))}
                </AnimatePresence>
              </motion.div>
            </section>
          );
        })}

        {me && waiting ? (
          <div className="mt-3 space-y-2 border-t pt-3">
            {me.membership === "active" ? (
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
            ) : null}
            {snapshot.allowSpectators || me.membership === "spectator" ? (
              <Button
                variant="ghost"
                className="w-full"
                disabled={busy}
                onClick={() => void run("ccb.player.spectate", { spectator: me.membership !== "spectator" })}
              >
                {me.membership === "spectator" ? "加入游戏" : "加入旁观"}
              </Button>
            ) : null}
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
  waiting: boolean;
  membership: "active" | "spectator";
  busy: boolean;
  /** 与 `useCCBAction` 的 `run` 同签名，避免每个玩家行各自重写命令类型。 */
  run: CCBRun;
}

function CCBPlayerRow({ player, snapshot, self, canManage, waiting, membership, busy, run }: CCBPlayerRowProps) {
  // 等待阶段用准备状态，开局后换成本局行动状态；旁观者只表达旁观。
  const status = waiting && membership === "active"
    ? { label: player.ready ? "准备" : "等待", tone: (player.ready ? "success" : "default") as PlayerStatusTone }
    : statuses[player.status];
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
      badges={<PlayerStatusPill label={status.label} tone={status.tone} />}
      meta={detail ? <span className="truncate font-sans text-[11px] text-muted-foreground">{detail}</span> : null}
      detail={player.marks ? <CCBMarks marks={player.marks} name={player.name} /> : null}
      actions={actions}
    />
  );
}
