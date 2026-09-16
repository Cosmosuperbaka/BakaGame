import { useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { ArrowUpRightFromCircle, Bot, Crown, Eye, EyeOff, UserX, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ScrollArea } from "@/components/ui/ScrollArea";
import {
  PLAYER_ME_MARK,
  PLAYER_ROW_BASE,
  PLAYER_ROW_HEIGHT,
  PlayerGroupTitle,
  PlayerStatusPill,
  type PlayerStatusTone,
} from "@/components/common/PlayerStatusPill";
import { listContainer, listItem, popover, tappable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useCCBStore } from "@/stores/UseCCBStore";
import type { CCBPhase, CCBPlayerView } from "@/types";

export interface PlayerListProps {
  players: CCBPlayerView[];
  myPlayerId?: string;
  isHost: boolean;
  phase: CCBPhase;
  allowSpectators: boolean;
}

export function PlayerList({ players, myPlayerId, isHost, phase, allowSpectators }: PlayerListProps) {
  const sendCommand = useCCBStore((state) => state.sendCommand);
  const setNotice = useCCBStore((state) => state.setNotice);
  const activePlayers = players.filter((player) => player.membership === "active");
  const observers = players.filter((player) => player.membership === "spectator");
  const me = players.find((player) => player.id === myPlayerId);
  const canJoinSpectators = Boolean(me) && allowSpectators && me?.membership === "active";
  const canJoinPlayers = me?.membership === "spectator";

  const handleKick = useCallback(
    async (playerId: string) => {
      try {
        await sendCommand("ccb.room.kick", { playerId });
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      }
    },
    [sendCommand, setNotice],
  );

  const handleTransferHost = useCallback(
    async (playerId: string) => {
      try {
        await sendCommand("ccb.room.transferHost", { playerId });
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      }
    },
    [sendCommand, setNotice],
  );

  const handleSetSpectator = useCallback(
    async (spectator: boolean) => {
      try {
        await sendCommand("ccb.player.setSpectator", { spectator });
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      }
    },
    [sendCommand, setNotice],
  );

  const renderRow = (player: CCBPlayerView, hideSpectatorStatus: boolean) => (
    <CCBPlayerRow
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
            <SpectatorToggle spectator={false} onToggle={handleSetSpectator} />
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
                <SpectatorToggle spectator onToggle={handleSetSpectator} />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </ScrollArea>
  );
}

interface CCBPlayerRowProps {
  player: CCBPlayerView;
  myPlayerId?: string;
  isHostViewer: boolean;
  phase: CCBPhase;
  hideSpectatorStatus: boolean;
  onKick: (playerId: string) => void;
  onTransferHost: (playerId: string) => void;
}

function CCBPlayerRow({
  player,
  myPlayerId,
  isHostViewer,
  phase,
  hideSpectatorStatus,
  onKick,
  onTransferHost,
}: CCBPlayerRowProps) {
  const isMe = player.id === myPlayerId;
  const canManage = isHostViewer && !isMe;
  const canTransfer = canManage && player.membership === "active" && player.online && !player.isBot;
  const status = resolveStatus(player, phase, hideSpectatorStatus);

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
      {isMe ? <span className={PLAYER_ME_MARK} /> : null}
      {status ? <PlayerStatusPill label={status.label} tone={status.tone} /> : null}
      <span className="min-w-0 flex-1 truncate font-medium">{player.name}</span>
      {player.isHost ? (
        <Crown className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="房主" />
      ) : null}
      {player.isBot ? (
        <Bot className="h-3.5 w-3.5 shrink-0 text-sky-500" aria-label="测试人机" />
      ) : !player.online ? (
        <WifiOff className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="已断线" />
      ) : null}
      <span className="shrink-0 font-sans text-xs font-normal tabular-nums text-muted-foreground">
        {player.score}
        <span className="ml-0.5 text-[10px]">分</span>
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

/**
 * 玩家状态胶囊。
 *
 * 只使用契约里可直接读出的字段——标记串的语义（谁猜中了）属于 `CCBRules`，
 * 在 P1 落地前不从 `marks` 字符里猜结论。
 */
function resolveStatus(
  player: CCBPlayerView,
  phase: CCBPhase,
  hideSpectatorStatus: boolean,
): { label: string; tone: PlayerStatusTone } | null {
  if (player.membership === "spectator") {
    return hideSpectatorStatus ? null : { label: "旁观", tone: "default" };
  }
  if (phase === "waiting") {
    return player.isReady
      ? { label: "准备", tone: "emerald" }
      : { label: "等待", tone: "default" };
  }
  if (phase === "answering") return { label: "出题", tone: "violet" };
  if (player.finished) return { label: "完成", tone: "default" };
  return { label: "作答中", tone: "amber" };
}

function SpectatorToggle({
  spectator,
  onToggle,
}: {
  spectator: boolean;
  onToggle: (spectator: boolean) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="mt-1 h-8 w-full min-w-0 justify-start gap-1.5 px-2 text-xs text-muted-foreground"
      onClick={() => onToggle(spectator)}
    >
      {spectator ? (
        <Eye className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <EyeOff className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="truncate">{spectator ? "加入旁观" : "取消旁观"}</span>
    </Button>
  );
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
