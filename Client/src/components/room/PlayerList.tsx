import { useCallback, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Crown,
  WifiOff,
  Bot,
  UserX,
  Eye,
  EyeOff,
  ArrowUpRightFromCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGame } from "@/contexts/GameContext";
import { ROLE_LABELS, ROLE_COLORS } from "@/lib/helpers";
import { cn } from "@/lib/utils";
import type { PublicPlayerView, GamePhase, PrivateState } from "@/types";

interface Props {
  players: PublicPlayerView[];
  hostPlayerId: string;
  myPlayerId?: string;
  isHost: boolean;
  phase: GamePhase;
  allowSpectators: boolean;
  privateState?: PrivateState | null;
}

// 动画统一参数：较短时长 + easeOut 曲线，避免列表扰动。
const rowMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.18, ease: "easeOut" as const },
};

export function PlayerList({
  players,
  myPlayerId,
  isHost,
  phase,
  allowSpectators,
  privateState,
}: Props) {
  const { sendCommand, addToast } = useGame();

  const handleKick = useCallback(
    async (playerId: string) => {
      try {
        await sendCommand("room.kick", { playerId });
      } catch (e) {
        addToast((e as { message: string }).message, "error");
      }
    },
    [sendCommand, addToast]
  );

  const handleTransferHost = useCallback(
    async (playerId: string) => {
      try {
        await sendCommand("room.transferHost", { playerId });
      } catch (e) {
        addToast((e as { message: string }).message, "error");
      }
    },
    [sendCommand, addToast]
  );

  const handleSetSpectator = useCallback(
    async (spectator: boolean) => {
      try {
        await sendCommand("player.setSpectator", { spectator });
      } catch (e) {
        addToast((e as { message: string }).message, "error");
      }
    },
    [sendCommand, addToast]
  );

  const activePlayers = [...players]
    .filter((p) => p.membership === "active")
    .sort((a, b) => {
      if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
      return 0;
    });

  const spectators = players.filter((p) => p.membership === "spectator");

  const me = players.find((p) => p.id === myPlayerId);
  const isSpectator = me?.membership === "spectator";
  const showSpectatorToggle = phase === "waiting" && allowSpectators && me;
  const waitingPhase = phase === "waiting";
  const hostActionsEnabled = waitingPhase || phase === "gameOver";
  const privilegedRoleMap = new Map(
    (privateState?.questionerView ?? []).map((entry) => [entry.playerId, entry.role])
  );

  return (
    <ScrollArea className="h-full">
      <div className="p-4 flex flex-col gap-0.5">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-2">
          玩家 ({activePlayers.length})
        </h3>
        <AnimatePresence initial={false} mode="popLayout">
          {activePlayers.map((player) => (
            <PlayerRow
              key={player.id}
              player={player}
              myPlayerId={myPlayerId}
              isHost={isHost}
              hostActionsEnabled={hostActionsEnabled}
              waitingPhase={waitingPhase}
              hideStatusWhenSpectator={false}
              privilegedRole={privilegedRoleMap.get(player.id)}
              onKick={handleKick}
              onTransferHost={handleTransferHost}
            />
          ))}
        </AnimatePresence>
        {showSpectatorToggle && isSpectator && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 gap-1.5 text-xs text-muted-foreground justify-start"
            onClick={() => handleSetSpectator(false)}
          >
            <EyeOff className="h-3.5 w-3.5" />
            取消旁观
          </Button>
        )}

        {(spectators.length > 0 || (showSpectatorToggle && !isSpectator)) && (
          <>
            <div className="border-t border-border/60 my-3" />
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-2">
              旁观 ({spectators.length})
            </h3>
            <AnimatePresence initial={false} mode="popLayout">
              {spectators.map((player) => (
                <PlayerRow
                  key={player.id}
                  player={player}
                  myPlayerId={myPlayerId}
                  isHost={isHost}
                  hostActionsEnabled={hostActionsEnabled}
                  waitingPhase={waitingPhase}
                  hideStatusWhenSpectator
                  privilegedRole={privilegedRoleMap.get(player.id)}
                  onKick={handleKick}
                  onTransferHost={handleTransferHost}
                />
              ))}
            </AnimatePresence>
            {showSpectatorToggle && !isSpectator && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 gap-1.5 text-xs text-muted-foreground justify-start"
                onClick={() => handleSetSpectator(true)}
              >
                <Eye className="h-3.5 w-3.5" />
                加入旁观
              </Button>
            )}
          </>
        )}
      </div>
    </ScrollArea>
  );
}

function PlayerRow({
  player,
  myPlayerId,
  isHost,
  hostActionsEnabled,
  waitingPhase,
  hideStatusWhenSpectator,
  privilegedRole,
  onKick,
  onTransferHost,
}: {
  player: PublicPlayerView;
  myPlayerId?: string;
  isHost: boolean;
  hostActionsEnabled: boolean;
  waitingPhase: boolean;
  hideStatusWhenSpectator: boolean;
  privilegedRole?: PrivateState["role"];
  onKick: (id: string) => void;
  onTransferHost: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const statusInfo = getStatusPill(player, hideStatusWhenSpectator);
  const canHostActOn = isHost && hostActionsEnabled && player.id !== myPlayerId;
  const visibleRole = privilegedRole ?? player.revealedRole;

  return (
    <motion.div
      layout="position"
      {...rowMotion}
      className={cn(
        "relative flex items-center gap-2 px-3 py-2 rounded-lg text-sm group transition-colors duration-150",
        player.id === myPlayerId && "bg-primary/8 ring-1 ring-primary/15",
        player.id !== myPlayerId && "hover:bg-muted/60",
        !player.online && "opacity-50"
      )}
      onBlur={() => setMenuOpen(false)}
    >
      <div className="flex-1 min-w-0 flex items-center gap-1.5">
        <span className="truncate font-medium text-sm">{player.name}</span>
        {player.isHost && (
          <Crown className="h-3.5 w-3.5 text-amber-500 shrink-0" aria-label="房主" />
        )}
        {player.isBot && (
          <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-label="机器人" />
        )}
        {!player.online && (
          <WifiOff className="h-3.5 w-3.5 text-destructive shrink-0" aria-label="离线" />
        )}
        {statusInfo && (
          <span className={cn("text-[11px] px-1.5 py-0.5 rounded shrink-0", statusInfo.className)}>
            {statusInfo.label}
          </span>
        )}
        {visibleRole && (
          <span
            className={cn(
              "text-[11px] font-semibold shrink-0",
              ROLE_COLORS[visibleRole]
            )}
          >
            {ROLE_LABELS[visibleRole]}
          </span>
        )}
        {player.score > 0 && (
          <span className="text-[11px] text-amber-600 font-medium shrink-0">
            {player.score}分
          </span>
        )}
      </div>

      {waitingPhase && player.membership === "active" && (
        <span
          className={cn(
            "text-[11px] px-1.5 py-0.5 rounded-full font-medium shrink-0",
            player.isReady
              ? "bg-emerald-100 text-emerald-700"
              : "bg-muted text-muted-foreground"
          )}
        >
          {player.isReady ? "已准备" : "未准备"}
        </span>
      )}

      {canHostActOn && (
        <div className="relative shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            aria-label="玩家操作"
          >
            <UserX className="h-3.5 w-3.5" />
          </Button>
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                initial={{ opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: 0.12, ease: "easeOut" }}
                className="absolute right-0 top-7 z-20 min-w-[9rem] rounded-md border bg-popover shadow-md py-1"
              >
                {waitingPhase && player.membership !== "kicked" && (
                  <button
                    type="button"
                    className="w-full text-left text-xs px-3 py-2 hover:bg-muted flex items-center gap-2 text-foreground"
                    onClick={() => {
                      setMenuOpen(false);
                      onTransferHost(player.id);
                    }}
                  >
                    <ArrowUpRightFromCircle className="h-3.5 w-3.5" />
                    转让房主
                  </button>
                )}
                <button
                  type="button"
                  className="w-full text-left text-xs px-3 py-2 hover:bg-muted flex items-center gap-2 text-destructive"
                  onClick={() => {
                    setMenuOpen(false);
                    onKick(player.id);
                  }}
                >
                  <UserX className="h-3.5 w-3.5" />
                  踢出房间
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}

// 身份徽章：旁观区不再重复显示"旁观"；出题人/存活/死亡等仍然显示。
function getStatusPill(
  player: PublicPlayerView,
  hideSpectatorPill: boolean
): { label: string; className: string } | null {
  switch (player.roundStatus) {
    case "questioner":
      return { label: "出题", className: "bg-purple-100 text-purple-700" };
    case "alive":
      return { label: "存活", className: "bg-emerald-100 text-emerald-700" };
    case "dead":
      return { label: "死亡", className: "bg-red-100 text-red-700" };
    case "kicked":
      return { label: "已踢出", className: "bg-red-100 text-red-700" };
    case "spectator":
      return hideSpectatorPill
        ? null
        : { label: "旁观", className: "bg-muted text-muted-foreground" };
    default:
      return null;
  }
}
