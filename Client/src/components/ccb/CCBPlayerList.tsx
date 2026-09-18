import * as Popover from "@radix-ui/react-popover";
import { Crown, MoreHorizontal, UserX, ArrowUpRightFromCircle, WifiOff } from "lucide-react";
import { motion } from "framer-motion";
import type { CCBPlayer, CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { PlayerAvatar } from "@/components/common/PlayerAvatar";
import { PlayerGroupTitle, PlayerStatusPill, PLAYER_ROW_BASE, PLAYER_ROW_HEIGHT, PLAYER_ME_MARK } from "@/components/common/PlayerStatusPill";
import { listItem, popover } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { CCBSelect } from "./CCBSelect";

const statuses: Record<CCBPlayer["status"], string> = { waiting: "等待", playing: "猜测中", solved: "猜中", teamWon: "队伍获胜", exhausted: "次数用尽", surrendered: "已放弃", observing: "旁观" };

export function CCBPlayerList({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const waiting = snapshot.phase === "waiting";
  const { run, busy } = useCCBAction();
  return <ScrollArea className="h-full"><div className="space-y-3 px-2 py-3">
    {(["active", "spectator"] as const).map((membership) => {
      const players = snapshot.players.filter((player) => player.membership === membership);
      return <section key={membership}><PlayerGroupTitle label={membership === "active" ? "玩家" : "旁观"} count={players.length} /><div className="space-y-px">{players.map((player) => {
        const self = player.id === privateState.playerId;
        const canManage = isHost && !self;
        const rowClass = cn(PLAYER_ROW_BASE, PLAYER_ROW_HEIGHT, "h-auto justify-start", self && "bg-primary/10", !player.online && "opacity-60");
        const progress = snapshot.phase === "guessing" && player.status !== "observing";
        const body = <>{self ? <span className={PLAYER_ME_MARK} /> : null}<PlayerAvatar /><span className="flex min-w-0 flex-1 flex-col gap-1"><span className="flex min-w-0 items-center gap-1"><span title={player.name} className="truncate">{player.name}</span>{snapshot.hostPlayerId === player.id ? <Crown className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="房主" /> : null}</span><span className="flex min-h-4 flex-wrap items-center gap-1"><PlayerStatusPill label={waiting && membership === "active" ? player.ready ? "准备" : "等待" : statuses[player.status]} tone={player.ready || player.status === "solved" || player.status === "teamWon" ? "emerald" : "default"} />{player.team !== null ? <span className="text-[11px] text-muted-foreground">{player.team} 队</span> : null}{!player.online ? <WifiOff aria-label="已断线" className="h-3.5 w-3.5 text-destructive" /> : null}{progress ? <span className="text-[11px] text-muted-foreground">{player.attempts}/{snapshot.settings.maxAttempts} 次{snapshot.settings.syncMode && player.syncCompleted ? " · 已提交" : ""}</span> : null}</span>{player.marks ? <span tabIndex={0} title={player.marks} aria-label={`${player.name} 猜测进度：${player.marks}`} className="block truncate text-xs focus-visible:whitespace-normal focus-visible:break-all">{player.marks}</span> : null}</span><span aria-label={`${player.score} 分`} className="shrink-0 whitespace-nowrap font-sans text-xs font-normal tabular-nums text-muted-foreground">{player.score} 分</span>{canManage ? <MoreHorizontal aria-hidden="true" /> : null}</>;
        return <motion.div key={player.id} variants={listItem} initial="initial" animate="animate" exit="exit" className="min-w-0">{canManage ? <Popover.Root><Popover.Trigger asChild><Button variant="ghost" className={rowClass} aria-label={`${player.name} 操作`}>{body}</Button></Popover.Trigger><Popover.Portal><Popover.Content side="right" sideOffset={6} collisionPadding={12} asChild><motion.div variants={popover} initial="initial" animate="animate" className="z-popover flex flex-col overflow-hidden rounded-md border bg-background/95 p-1 shadow-md backdrop-blur-md"><Popover.Close asChild><Button variant="ghost" disabled={busy || !player.online} onClick={() => void run("ccb.room.transferHost", { playerId: player.id })}><ArrowUpRightFromCircle />转移房主</Button></Popover.Close><Popover.Close asChild><Button variant="ghost" className="text-destructive" disabled={busy} onClick={() => void run("ccb.room.kick", { playerId: player.id })}><UserX />踢出玩家</Button></Popover.Close></motion.div></Popover.Content></Popover.Portal></Popover.Root> : <div className={rowClass}>{body}</div>}</motion.div>;
      })}</div></section>;
    })}
    {me && waiting ? <div className="space-y-2 border-t pt-3">
      {me.membership === "active" ? <CCBSelect label="我的队伍" value={me.team === null ? "solo" : String(me.team)} options={[{ value: "solo", label: "个人游玩" }, ...Array.from({ length: 8 }, (_, index) => ({ value: String(index + 1), label: `第 ${index + 1} 队` }))]} disabled={busy} onChange={(value) => void run("ccb.player.team", { team: value === "solo" ? null : Number(value) })} /> : null}
      {snapshot.allowSpectators || me.membership === "spectator" ? <Button variant="ghost" className="w-full" disabled={busy} onClick={() => void run("ccb.player.spectate", { spectator: me.membership !== "spectator" })}>{me.membership === "spectator" ? "加入游戏" : "加入旁观"}</Button> : null}
    </div> : null}
  </div></ScrollArea>;
}
