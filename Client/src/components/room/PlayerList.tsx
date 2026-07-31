import { useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { ArrowUpRightFromCircle, Crown, Eye, EyeOff, UserX, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ROLE_COLORS, ROLE_LABELS } from "@/lib/helpers";
import { cn } from "@/lib/utils";
import { useGameStore } from "@/stores/useGameStore";
import type { GamePhase, PlayerRole, PrivateState, PublicPlayerView, RoleConfig } from "@/types";

export type PlayerMark = "unknown" | PlayerRole;
export type PlayerMarks = Record<string, PlayerMark>;

const roleButtonLabels: Record<PlayerMark, string> = {
  unknown: "未",
  civilian: "民",
  undercover: "卧",
  blank: "白",
  angel: "天",
};

const roleDisplayLabels: Record<PlayerMark, string> = {
  unknown: "未知",
  civilian: "平民",
  undercover: "卧底",
  blank: "白板",
  angel: "天使",
};

const rowMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.18, ease: "easeOut" as const },
};

export interface PlayerListProps {
  players: PublicPlayerView[];
  hostPlayerId: string;
  myPlayerId?: string;
  isHost: boolean;
  phase: GamePhase;
  allowSpectators: boolean;
  roleConfig: RoleConfig;
  privateState?: PrivateState | null;
  playerMarks: PlayerMarks;
  onMarkChange: (playerId: string, mark: PlayerMark) => void;
}

export function PlayerList(props: PlayerListProps) {
  const {
    players,
    myPlayerId,
    isHost,
    phase,
    allowSpectators,
    roleConfig,
    privateState,
    playerMarks,
    onMarkChange,
  } = props;
  const sendCommand = useGameStore((state) => state.sendCommand);
  const addToast = useGameStore((state) => state.addToast);
  const waitingPhase = phase === "waiting";
  const me = players.find((player) => player.id === myPlayerId);
  const isSpectator = me?.membership === "spectator";
  const canMarkPlayers =
    me?.membership === "active" &&
    !privateState?.isQuestioner &&
    !["waiting", "assigningQuestioner", "wordSubmission", "gameOver"].includes(phase);
  const showSpectatorToggle = waitingPhase && allowSpectators && Boolean(me);
  const roleByPlayerId = new Map(
    (privateState?.questionerView ?? []).map((entry) => [entry.playerId, entry.role]),
  );
  const availableMarks: PlayerMark[] = [
    "unknown",
    "civilian",
    "undercover",
    ...(roleConfig.hasBlank ? (["blank"] as PlayerMark[]) : []),
    ...(roleConfig.hasAngel ? (["angel"] as PlayerMark[]) : []),
  ];

  const activePlayers = players.filter(
    (player) => player.membership === "active" && player.roundStatus !== "questioner",
  );
  const observers = players.filter(
    (player) => player.membership === "spectator" || player.roundStatus === "questioner",
  );

  const handleKick = useCallback(
    async (playerId: string) => {
      try {
        await sendCommand("room.kick", { playerId });
      } catch (error) {
        addToast((error as { message: string }).message, "error");
      }
    },
    [addToast, sendCommand],
  );

  const handleTransferHost = useCallback(
    async (playerId: string) => {
      try {
        await sendCommand("room.transferHost", { playerId });
      } catch (error) {
        addToast((error as { message: string }).message, "error");
      }
    },
    [addToast, sendCommand],
  );

  const handleSetSpectator = useCallback(
    async (spectator: boolean) => {
      try {
        await sendCommand("player.setSpectator", { spectator });
      } catch (error) {
        addToast((error as { message: string }).message, "error");
      }
    },
    [addToast, sendCommand],
  );

  const renderRow = (player: PublicPlayerView, hideSpectatorStatus: boolean) => (
    <PlayerRow
      key={player.id}
      player={player}
      myPlayerId={myPlayerId}
      isHostViewer={isHost}
      waitingPhase={waitingPhase}
      hideSpectatorStatus={hideSpectatorStatus}
      actualRole={roleByPlayerId.get(player.id)}
      mark={playerMarks[player.id] ?? "unknown"}
      canMark={Boolean(
        canMarkPlayers &&
          player.membership === "active" &&
          player.roundStatus !== "questioner"
      )}
      availableMarks={availableMarks}
      onMarkChange={onMarkChange}
      onKick={handleKick}
      onTransferHost={handleTransferHost}
    />
  );

  return (
    <ScrollArea className="h-full">
      <div className="flex w-full flex-col gap-0.5 p-3">
        <PlayerGroupTitle label="玩家" count={activePlayers.length} />
        <AnimatePresence initial={false} mode="popLayout">
          {activePlayers.map((player) => renderRow(player, false))}
        </AnimatePresence>

        {showSpectatorToggle && isSpectator ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 justify-start gap-1.5 text-xs text-muted-foreground"
            onClick={() => handleSetSpectator(false)}
          >
            <EyeOff className="h-3.5 w-3.5" />
            取消旁观
          </Button>
        ) : null}

        {observers.length > 0 || (showSpectatorToggle && !isSpectator) ? (
          <>
            <div className="my-3 h-px bg-border/60" />
            <PlayerGroupTitle label="旁观" count={observers.length} />
            <AnimatePresence initial={false} mode="popLayout">
              {observers.map((player) => renderRow(player, true))}
            </AnimatePresence>
            {showSpectatorToggle && !isSpectator ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 justify-start gap-1.5 text-xs text-muted-foreground"
                onClick={() => handleSetSpectator(true)}
              >
                <Eye className="h-3.5 w-3.5" />
                加入旁观
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function PlayerGroupTitle({ label, count }: { label: string; count: number }) {
  return (
    <h3 className="mb-2 px-2 text-xs font-semibold text-muted-foreground">
      {label} ({count})
    </h3>
  );
}

export interface PlayerRowProps {
  player: PublicPlayerView;
  myPlayerId?: string;
  isHostViewer: boolean;
  waitingPhase: boolean;
  hideSpectatorStatus: boolean;
  actualRole?: PlayerRole;
  mark: PlayerMark;
  canMark: boolean;
  availableMarks: PlayerMark[];
  onMarkChange: (playerId: string, mark: PlayerMark) => void;
  onKick: (playerId: string) => void;
  onTransferHost: (playerId: string) => void;
  embedded?: boolean;
}

export function PlayerRow(props: PlayerRowProps) {
  const {
    player,
    myPlayerId,
    isHostViewer,
    hideSpectatorStatus,
    actualRole,
    mark,
    canMark,
    availableMarks,
    onMarkChange,
    onKick,
    onTransferHost,
    embedded = false,
  } = props;
  const canHostActOn = isHostViewer && player.id !== myPlayerId;
  const isMe = player.id === myPlayerId;
  const isInteractive = canMark || canHostActOn;
  const visibleRole = player.revealedRole ?? actualRole ?? (canMark ? mark : undefined);
  const statusInfo = getStatusPill(player, hideSpectatorStatus);

  const row = (
    <motion.div
      layout="position"
      {...rowMotion}
      className={cn(
        "group flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors",
        isMe ? "bg-primary/8 ring-1 ring-primary/15" : "hover:bg-muted/70",
        !player.online && "opacity-50",
        isInteractive && "cursor-pointer",
        embedded && "rounded-none px-3",
      )}
    >
      <span className="flex h-6 min-w-8 shrink-0 items-center justify-center rounded-md bg-muted px-1.5 text-xs font-bold tabular-nums text-foreground">
        {player.score}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{player.name}</span>
      <span className="flex shrink-0 items-center gap-1">
        {player.isHost ? <Crown className="h-3.5 w-3.5 text-amber-500" aria-label="房主" /> : null}
        {!player.online ? <WifiOff className="h-3.5 w-3.5 text-destructive" aria-label="离线" /> : null}
        {statusInfo ? (
          <span className={cn("rounded px-1.5 py-0.5 text-[11px]", statusInfo.className)}>
            {statusInfo.label}
          </span>
        ) : null}
        {visibleRole ? <RoleDisplay role={visibleRole} /> : null}
      </span>
    </motion.div>
  );

  if (!isInteractive) return row;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>{row}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={8}
          className="z-[80] w-64 rounded-md border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          {canMark ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-1" role="group" aria-label="身份标记">
                {availableMarks.map((availableMark) => {
                  const selected = mark === availableMark;
                  return (
                    <button
                      key={availableMark}
                      type="button"
                      title={roleDisplayLabels[availableMark]}
                      aria-label={roleDisplayLabels[availableMark]}
                      aria-pressed={selected}
                      onClick={() => onMarkChange(player.id, availableMark)}
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-colors",
                        selected
                          ? "bg-foreground text-background"
                          : "bg-muted text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {roleButtonLabels[availableMark]}
                    </button>
                  );
                })}
              </div>
              <div className="text-center text-xs font-medium text-muted-foreground">
                当前：{roleDisplayLabels[mark]}
              </div>
            </div>
          ) : null}

          {canHostActOn ? (
            <div className={cn("grid grid-cols-2 gap-2", canMark && "mt-3 border-t pt-3")}>
              <button
                type="button"
                className="flex items-center justify-center gap-1.5 rounded-md bg-muted px-2 py-2 text-xs font-medium hover:bg-muted/70"
                onClick={() => onTransferHost(player.id)}
              >
                <ArrowUpRightFromCircle className="h-3.5 w-3.5" />
                转移房主
              </button>
              <button
                type="button"
                className="flex items-center justify-center gap-1.5 rounded-md bg-destructive/10 px-2 py-2 text-xs font-medium text-destructive hover:bg-destructive/15"
                onClick={() => onKick(player.id)}
              >
                <UserX className="h-3.5 w-3.5" />
                踢出
              </button>
            </div>
          ) : null}
          <Popover.Arrow className="fill-popover" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function RoleDisplay({ role }: { role: PlayerMark }) {
  return (
    <span
      className={cn(
        "flex h-6 min-w-10 items-center justify-center rounded-md bg-muted px-1.5 text-[11px] font-semibold",
        role === "unknown" ? "text-muted-foreground" : ROLE_COLORS[role],
      )}
    >
      {role === "unknown" ? "未知" : ROLE_LABELS[role]}
    </span>
  );
}

function getStatusPill(
  player: PublicPlayerView,
  hideSpectatorPill: boolean,
): { label: string; className: string } | null {
  switch (player.roundStatus) {
    case "questioner":
      return { label: "出题", className: "bg-violet-100 text-violet-700" };
    case "alive":
      return null;
    case "dead":
      return { label: "出局", className: "bg-red-100 text-red-700" };
    case "kicked":
      return { label: "踢出", className: "bg-red-100 text-red-700" };
    case "spectator":
      return hideSpectatorPill ? null : { label: "旁观", className: "bg-muted text-muted-foreground" };
    default:
      return waitingPhaseStatus(player, hideSpectatorPill);
  }
}

function waitingPhaseStatus(
  player: PublicPlayerView,
  hideSpectatorPill: boolean,
): { label: string; className: string } | null {
  if (hideSpectatorPill || player.membership !== "active") return null;
  return player.isReady
    ? { label: "准备", className: "bg-emerald-100 text-emerald-700" }
    : { label: "未备", className: "bg-muted text-muted-foreground" };
}
