import { useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { ArrowUpRightFromCircle, Bot, Crown, Eye, EyeOff, UserX, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { PlayerGroupTitle, PLAYER_ROW_HEIGHT } from "@/components/whoisfaker/layout/PlayerList";
import { PLAYER_ME_MARK, PLAYER_ROW_BASE, PlayerStatusPill } from "@/components/whoisfaker/layout/PlayerStatusPill";
import { listContainer, listItem, popover, tappable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useSonGuessrStore as useSongGuessrStore } from "@/stores/UseSonGuessrStore";
import type { SongGuessrPhase, SongGuessrPlayerView } from "@/types";

type SongStatus = {
  label: string;
  tone: "default" | "emerald" | "violet" | "amber";
};

interface SongPlayerListProps {
  players: SongGuessrPlayerView[];
  myPlayerId?: string;
  isHost: boolean;
  phase: SongGuessrPhase;
  allowSpectators: boolean;
}

export function SongPlayerList({
  players,
  myPlayerId,
  isHost,
  phase,
  allowSpectators,
}: SongPlayerListProps) {
  const sendCommand = useSongGuessrStore((state) => state.sendCommand);
  const setNotice = useSongGuessrStore((state) => state.setNotice);
  const activePlayers = players.filter((player) => player.membership === "active");
  const observers = players.filter((player) => player.membership === "spectator");
  const me = players.find((player) => player.id === myPlayerId);
  const waitingPhase = phase === "waiting";
  const canJoinSpectators =
    Boolean(me) &&
    allowSpectators &&
    me?.membership === "active";
  const canJoinPlayers = me?.membership === "spectator";

  const handleKick = useCallback(
    async (playerId: string) => {
      try {
        await sendCommand("song.room.kick", { playerId });
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      }
    },
    [sendCommand, setNotice],
  );

  const handleTransferHost = useCallback(
    async (playerId: string) => {
      try {
        await sendCommand("song.room.transferHost", { playerId });
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      }
    },
    [sendCommand, setNotice],
  );

  const handleSetSpectator = useCallback(
    async (spectator: boolean) => {
      try {
        await sendCommand("song.player.setSpectator", { spectator });
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      }
    },
    [sendCommand, setNotice],
  );

  const renderRow = (player: SongGuessrPlayerView, hideSpectatorStatus: boolean) => (
    <SongPlayerRow
      key={player.id}
      player={player}
      myPlayerId={myPlayerId}
      isHostViewer={isHost}
      phase={phase}
      hideSpectatorStatus={hideSpectatorStatus}
      onKick={handleKick}
      onTransferHost={handleTransferHost}
    />
  );

  return (
    <ScrollArea className="h-full">
      <div className="min-w-0 px-2">
        <div className="relative flex min-w-0 w-full flex-col py-3">
          <PlayerGroupTitle label="玩家" count={activePlayers.length} />
          <motion.div
            className="flex flex-col gap-px"
            variants={listContainer(activePlayers.length)}
            initial={false}
            animate="animate"
          >
            <AnimatePresence initial={false}>
              {activePlayers.map((player) => renderRow(player, false))}
            </AnimatePresence>
          </motion.div>

          {canJoinPlayers ? (
            <SpectatorToggle
              spectator={false}
              queued={!waitingPhase}
              selected={me?.nextRoundMembership === "active"}
              onToggle={handleSetSpectator}
            />
          ) : null}

          {observers.length > 0 || canJoinSpectators ? (
            <>
              <PlayerGroupTitle label="旁观" count={observers.length} withRule />
              <motion.div
                className="flex flex-col gap-px"
                variants={listContainer(observers.length)}
                initial={false}
                animate="animate"
              >
                <AnimatePresence initial={false}>
                  {observers.map((player) => renderRow(player, true))}
                </AnimatePresence>
              </motion.div>
              {canJoinSpectators ? (
                <SpectatorToggle
                  spectator
                  queued={!waitingPhase}
                  selected={me?.nextRoundMembership === "spectator"}
                  onToggle={handleSetSpectator}
                />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </ScrollArea>
  );
}

interface SongPlayerRowProps {
  player: SongGuessrPlayerView;
  myPlayerId?: string;
  isHostViewer: boolean;
  phase: SongGuessrPhase;
  hideSpectatorStatus: boolean;
  onKick: (playerId: string) => void;
  onTransferHost: (playerId: string) => void;
}

function SongPlayerRow({
  player,
  myPlayerId,
  isHostViewer,
  phase,
  hideSpectatorStatus,
  onKick,
  onTransferHost,
}: SongPlayerRowProps) {
  const isMe = player.id === myPlayerId;
  const canManage = isHostViewer && !isMe;
  const canTransfer = canManage && player.membership === "active" && player.online && !player.isBot;
  const status = resolveSongStatus(player, phase, hideSpectatorStatus);

  const body = (
    <div
      className={cn(
        PLAYER_ROW_BASE,
        PLAYER_ROW_HEIGHT,
        isMe && "bg-primary/10",
        !isMe && "transition-colors hover:bg-accent/50",
        !player.online && !player.isBot && "opacity-60",
        canManage && "cursor-pointer",
      )}
    >
      {isMe ? (
        <span className={PLAYER_ME_MARK} />
      ) : null}
      {status ? <StatusPill {...status} /> : null}
      <span className="min-w-0 flex-1 truncate font-medium">{player.name}</span>
      {player.isHost ? (
        <Crown className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="房主" />
      ) : null}
      {player.isBot ? (
        <Bot className="h-3.5 w-3.5 shrink-0 text-sky-500" aria-label="测试人机" />
      ) : !player.online ? (
        <WifiOff className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="已断线" />
      ) : null}
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {player.score}<span className="ml-0.5 text-[10px]">分</span>
      </span>
    </div>
  );

  const content = (
    <motion.div
      variants={listItem}
      initial="initial"
      animate="animate"
      exit="exit"
      layout="position"
      className="w-full min-w-0"
    >
      {body}
    </motion.div>
  );

  if (!canManage) return content;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <div role="button" tabIndex={0} aria-label={`${player.name} 操作`} className="w-full min-w-0">
          {content}
        </div>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="right" align="center" sideOffset={6} collisionPadding={12} asChild>
          <motion.div
            variants={popover}
            initial="initial"
            animate="animate"
            className="z-[80] overflow-hidden rounded-md border bg-background/95 shadow-md backdrop-blur-md"
          >
            <div className="flex flex-col">
              {canTransfer ? (
                <ManageButton
                  icon={<ArrowUpRightFromCircle className="h-3.5 w-3.5" />}
                  label="转移房主"
                  onClick={() => onTransferHost(player.id)}
                />
              ) : null}
              <ManageButton
                icon={<UserX className="h-3.5 w-3.5" />}
                label="踢出玩家"
                destructive
                onClick={() => onKick(player.id)}
              />
            </div>
          </motion.div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function resolveSongStatus(
  player: SongGuessrPlayerView,
  phase: SongGuessrPhase,
  hideSpectatorStatus: boolean,
): SongStatus | null {
  if (player.membership === "spectator") {
    return hideSpectatorStatus ? null : { label: "旁观", tone: "default" };
  }
  if (phase === "waiting") {
    return player.isReady
      ? { label: "准备", tone: "emerald" }
      : { label: "等待", tone: "default" };
  }
  if (player.roundStatus === "submitter") return { label: "出题", tone: "violet" };
  if (player.roundStatus === "guessing") return { label: "猜歌", tone: "amber" };
  if (player.roundStatus === "correct") return { label: "猜中", tone: "emerald" };
  if (player.roundStatus === "finished") return { label: "完成", tone: "default" };
  return null;
}

function SpectatorToggle({
  spectator,
  queued,
  selected,
  onToggle,
}: {
  spectator: boolean;
  queued: boolean;
  selected: boolean;
  onToggle: (spectator: boolean) => void;
}) {
  const label = queued
    ? spectator ? "下轮加入旁观" : "下轮加入游戏"
    : spectator ? "加入旁观" : "取消旁观";
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      size="sm"
      className="mt-1 h-8 w-full min-w-0 justify-start gap-1.5 px-2 text-xs text-muted-foreground"
      onClick={() => onToggle(spectator)}
    >
      {spectator ? <Eye className="h-3.5 w-3.5 shrink-0" /> : <EyeOff className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate">{selected ? `${label}（已选择）` : label}</span>
    </Button>
  );
}

function StatusPill({ label, tone }: SongStatus) {
  return <PlayerStatusPill label={label} tone={tone} />;
}

function ManageButton({
  icon,
  label,
  destructive,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <Popover.Close asChild>
      <motion.button
        type="button"
        {...tappable}
        onClick={onClick}
        className={cn(
          "flex w-full items-center gap-2 px-4 py-2.5 text-xs font-medium transition-colors",
          "border-t first:border-t-0",
          destructive
            ? "text-destructive hover:bg-destructive hover:text-destructive-foreground"
            : "text-foreground hover:bg-accent hover:text-accent-foreground",
        )}
      >
        {icon}
        {label}
      </motion.button>
    </Popover.Close>
  );
}
