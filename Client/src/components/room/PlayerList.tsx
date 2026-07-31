import { useCallback, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Crown,
  WifiOff,
  MoreHorizontal,
  UserX,
  Eye,
  EyeOff,
  ArrowUpRightFromCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGameStore } from "@/stores/useGameStore";
import { ROLE_LABELS, ROLE_COLORS } from "@/lib/helpers";
import { cn } from "@/lib/utils";
import type { PublicPlayerView, GamePhase, PrivateState } from "@/types";

type PlayerMark = "none" | "suspect" | "safe";

const ROLE_SHORT_LABELS: Record<NonNullable<PrivateState["role"]>, string> = {
  civilian: "民",
  undercover: "卧",
  angel: "天",
  blank: "白",
};

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
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);

  // 本地玩家标记：仅在该玩家自己的界面可见，不同步至服务端。
  const [playerMarks, setPlayerMarks] = useState<Record<string, PlayerMark>>({});
  const toggleMark = useCallback((playerId: string) => {
    setPlayerMarks((prev) => {
      const cur: PlayerMark = prev[playerId] ?? "none";
      const next: PlayerMark =
        cur === "none" ? "suspect" : cur === "suspect" ? "safe" : "none";
      return { ...prev, [playerId]: next };
    });
  }, []);

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
      <div className="flex w-full flex-col gap-0.5 p-4">
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
              mark={playerMarks[player.id] ?? "none"}
              onToggleMark={toggleMark}
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
                  mark={playerMarks[player.id] ?? "none"}
                  onToggleMark={toggleMark}
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
  mark,
  onToggleMark,
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
  mark: PlayerMark;
  onToggleMark: (id: string) => void;
  onKick: (id: string) => void;
  onTransferHost: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const statusInfo = getStatusPill(player, hideStatusWhenSpectator);
  const canHostActOn = isHost && hostActionsEnabled && player.id !== myPlayerId;
  const visibleRole = privilegedRole ?? player.revealedRole;
  const isMe = player.id === myPlayerId;

  return (
    <motion.div
      layout="position"
      {...rowMotion}
      className={cn(
        "group relative flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors duration-150",
        isMe && "bg-primary/8 ring-1 ring-primary/15",
        !isMe && "hover:bg-muted/60",
        !player.online && "opacity-50"
      )}
      onBlur={() => setMenuOpen(false)}
    >
      {/* 本地标记（仅自己可见，点击循环切换：无→疑→安→无） */}
      <button
        type="button"
        aria-label={`切换玩家标记，当前${mark === "suspect" ? "可疑" : mark === "safe" ? "安全" : "无标记"}`}
        title={mark === "suspect" ? "可疑" : mark === "safe" ? "安全" : "添加标记"}
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[10px] font-bold transition-colors",
          mark === "suspect" && "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950/50 dark:text-orange-300",
          mark === "safe" && "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
          mark === "none" && "border-transparent text-transparent group-hover:border-border group-hover:text-muted-foreground/50"
        )}
        onClick={(e) => { e.stopPropagation(); onToggleMark(player.id); }}
      >
        {mark === "suspect" ? "疑" : mark === "safe" ? "安" : "标"}
      </button>

      {/* 左：玩家名 */}
      <span className="truncate font-medium text-sm flex-1 min-w-0">{player.name}</span>

      {/* 右：状态徽章区 */}
      <div className="flex items-center gap-1 shrink-0">
        {player.isHost && (
          <Crown className="h-3.5 w-3.5 text-amber-500" aria-label="房主" />
        )}
        {!player.online && (
          <WifiOff className="h-3.5 w-3.5 text-destructive" aria-label="离线" />
        )}
        {statusInfo && (
          <span className={cn("text-[11px] px-1.5 py-0.5 rounded", statusInfo.className)}>
            {statusInfo.label}
          </span>
        )}
        {visibleRole && (
          <span
            title={ROLE_LABELS[visibleRole]}
            aria-label={`身份：${ROLE_LABELS[visibleRole]}`}
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded border bg-background text-[10px] font-bold",
              ROLE_COLORS[visibleRole]
            )}
          >
            {ROLE_SHORT_LABELS[visibleRole]}
          </span>
        )}
        {player.score > 0 && (
          <span className="text-[11px] text-amber-600 font-medium">{player.score}分</span>
        )}
        {waitingPhase && player.membership === "active" && (
          <span
            className={cn(
              "text-[11px] px-1.5 py-0.5 rounded-full font-medium",
              player.isReady
                ? "bg-emerald-100 text-emerald-700"
                : "bg-muted text-muted-foreground"
            )}
          >
            {player.isReady ? "已准备" : "未准备"}
          </span>
        )}
      </div>

      {/* 固定宽度操作槽位，保证房主与其他玩家的条目对称。 */}
      <div className="relative h-6 w-6 shrink-0">
        {canHostActOn ? (
          <>
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
            <MoreHorizontal className="h-3.5 w-3.5" />
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
                    onClick={() => { setMenuOpen(false); onTransferHost(player.id); }}
                  >
                    <ArrowUpRightFromCircle className="h-3.5 w-3.5" />
                    转让房主
                  </button>
                )}
                <button
                  type="button"
                  className="w-full text-left text-xs px-3 py-2 hover:bg-muted flex items-center gap-2 text-destructive"
                  onClick={() => { setMenuOpen(false); onKick(player.id); }}
                >
                  <UserX className="h-3.5 w-3.5" />
                  踢出房间
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          </>
        ) : null}
      </div>
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
