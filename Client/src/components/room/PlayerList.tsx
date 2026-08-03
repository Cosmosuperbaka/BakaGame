import { useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { ArrowUpRightFromCircle, Crown, Eye, EyeOff, UserX, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { listContainer, listItem, popover, tappable } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useGameStore } from "@/stores/useGameStore";
import type { GamePhase, PlayerRole, PrivateState, PublicPlayerView, RoleConfig } from "@/types";

export type PlayerMark = "unknown" | PlayerRole;
export type PlayerMarks = Record<string, PlayerMark>;

/** 身份预测按钮上的单字 */
const markGlyphs: Record<PlayerMark, string> = {
  unknown: "？",
  civilian: "好",
  undercover: "坏",
  blank: "白",
  angel: "天",
};

/** 身份预测的完整名称，用于可访问名称与提示 */
const markNames: Record<PlayerMark, string> = {
  unknown: "未知",
  civilian: "平民",
  undercover: "卧底",
  blank: "白板",
  angel: "天使",
};

/** 身份预测选中态的配色 */
const markTones: Record<PlayerMark, string> = {
  unknown: "bg-muted-foreground/80 text-background",
  civilian: "bg-blue-600 text-white",
  undercover: "bg-red-600 text-white",
  blank: "bg-stone-500 text-white",
  angel: "bg-amber-500 text-white",
};

/** 玩家行与发言历史首栏共用的行高，保证两处对齐 */
export const PLAYER_ROW_HEIGHT = "min-h-10";

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
          player.roundStatus !== "questioner",
      )}
      availableMarks={availableMarks}
      onMarkChange={onMarkChange}
      onKick={handleKick}
      onTransferHost={handleTransferHost}
    />
  );

  return (
    <ScrollArea className="h-full">
      <div className="flex w-full flex-col px-2 py-3">
        <PlayerGroupTitle label="玩家" count={activePlayers.length} />
        <motion.div
          className="flex flex-col gap-px"
          variants={listContainer(activePlayers.length)}
          initial={false}
          animate="animate"
        >
          <AnimatePresence initial={false} mode="popLayout">
            {activePlayers.map((player) => renderRow(player, false))}
          </AnimatePresence>
        </motion.div>

        {showSpectatorToggle && isSpectator ? (
          <SpectatorToggle spectator={false} onToggle={handleSetSpectator} />
        ) : null}

        {observers.length > 0 || (showSpectatorToggle && !isSpectator) ? (
          <>
            <PlayerGroupTitle label="旁观" count={observers.length} withRule />
            <motion.div
              className="flex flex-col gap-px"
              variants={listContainer(observers.length)}
              initial={false}
              animate="animate"
            >
              <AnimatePresence initial={false} mode="popLayout">
                {observers.map((player) => renderRow(player, true))}
              </AnimatePresence>
            </motion.div>
            {showSpectatorToggle && !isSpectator ? (
              <SpectatorToggle spectator onToggle={handleSetSpectator} />
            ) : null}
          </>
        ) : null}
      </div>
    </ScrollArea>
  );
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
      className="mt-1 h-8 justify-start gap-1.5 px-2 text-xs text-muted-foreground"
      onClick={() => onToggle(spectator)}
    >
      {spectator ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
      {spectator ? "加入旁观" : "取消旁观"}
    </Button>
  );
}

export function PlayerGroupTitle({
  label,
  count,
  withRule = false,
}: {
  label: string;
  count: number;
  withRule?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2 px-2", withRule ? "mt-4 mb-1.5" : "mb-1.5")}>
      <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground">
        {label}
      </h3>
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
        {count}
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

export interface PlayerRowProps {
  player: PublicPlayerView;
  myPlayerId?: string;
  isHostViewer: boolean;
  waitingPhase: boolean;
  hideSpectatorStatus?: boolean;
  actualRole?: PlayerRole;
  mark: PlayerMark;
  canMark: boolean;
  availableMarks: PlayerMark[];
  onMarkChange: (playerId: string, mark: PlayerMark) => void;
  onKick: (playerId: string) => void;
  onTransferHost: (playerId: string) => void;
  /** 嵌入发言历史首栏时去掉行自身的进出场动画，交由表格统一处理 */
  embedded?: boolean;
}

export function PlayerRow(props: PlayerRowProps) {
  const {
    player,
    myPlayerId,
    isHostViewer,
    waitingPhase,
    hideSpectatorStatus,
    actualRole,
    mark,
    canMark,
    availableMarks,
    onMarkChange,
    onKick,
    onTransferHost,
    embedded,
  } = props;

  const isMe = player.id === myPlayerId;
  const canManage = isHostViewer && !isMe && waitingPhase;
  const interactive = canMark || canManage;
  const eliminated = player.roundStatus === "dead";
  const status = resolveStatus(player, waitingPhase, hideSpectatorStatus);

  const body = (
    <div
      className={cn(
        "relative flex w-full items-center gap-2.5 rounded-md py-1.5 pl-3 pr-2 text-left text-sm",
        PLAYER_ROW_HEIGHT,
        isMe && "bg-primary/10",
        !isMe && interactive && "hover:bg-accent/50",
        !player.online && "opacity-60",
        interactive && "cursor-pointer",
      )}
    >
      {isMe ? (
        <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
      ) : null}
      <span className="w-4 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {player.score}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-medium",
          eliminated && "text-muted-foreground line-through decoration-muted-foreground/60",
        )}
      >
        {player.name}
      </span>
      {!player.online ? (
        <WifiOff className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="已断线" />
      ) : null}
      {player.isHost ? (
        <Crown className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="房主" />
      ) : null}
      {actualRole ? <RoleTag role={actualRole} /> : null}
      {mark !== "unknown" ? <MarkChip mark={mark} /> : null}
      {status ? <StatusPill tone={status.tone} label={status.label} /> : null}
    </div>
  );

  const content = embedded ? (
    body
  ) : (
    <motion.div variants={listItem} initial="initial" animate="animate" exit="exit" layout="position">
      {body}
    </motion.div>
  );

  if (!interactive) return content;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <div role="button" tabIndex={0} aria-label={`${player.name} 操作`}>
          {content}
        </div>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          asChild
        >
          <motion.div
            variants={popover}
            initial="initial"
            animate="animate"
            className="z-[80] w-[13.5rem] rounded-md bg-popover p-1.5 text-popover-foreground shadow-lg"
          >
            {canMark ? (
              <div className="flex items-stretch gap-1">
                {availableMarks.map((option) => (
                  <MarkButton
                    key={option}
                    option={option}
                    selected={mark === option}
                    onSelect={() => onMarkChange(player.id, option)}
                  />
                ))}
              </div>
            ) : null}
            {canManage ? (
              <div className={cn("flex items-stretch gap-1", canMark && "mt-1")}>
                <ManageButton
                  icon={<ArrowUpRightFromCircle className="h-3.5 w-3.5" />}
                  label="转移房主"
                  onClick={() => onTransferHost(player.id)}
                />
                <ManageButton
                  icon={<UserX className="h-3.5 w-3.5" />}
                  label="踢出玩家"
                  destructive
                  onClick={() => onKick(player.id)}
                />
              </div>
            ) : null}
          </motion.div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/* ── 局部小组件 ─────────────────────────────────────────── */

function MarkButton({
  option,
  selected,
  onSelect,
}: {
  option: PlayerMark;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <motion.button
      {...tappable}
      aria-label={markNames[option]}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex flex-1 items-center justify-center rounded py-1.5 text-sm font-semibold",
        "ring-1 ring-inset ring-border transition-colors",
        selected ? markTones[option] : "text-muted-foreground hover:bg-accent/60",
      )}
    >
      {markGlyphs[option]}
    </motion.button>
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
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          "h-8 flex-1 gap-1.5 rounded text-xs font-medium ring-1 ring-inset ring-border",
          destructive
            ? "text-destructive hover:bg-destructive/10 hover:ring-destructive/40"
            : "hover:bg-accent/70",
        )}
        onClick={onClick}
      >
        {icon}
        {label}
      </Button>
    </Popover.Close>
  );
}

function MarkChip({ mark }: { mark: PlayerMark }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-px text-[10px] font-semibold leading-none",
        markTones[mark],
      )}
      aria-label={markNames[mark]}
    >
      {markGlyphs[mark]}
    </span>
  );
}

function RoleTag({ role }: { role: PlayerRole }) {
  const label: Record<PlayerRole, string> = {
    civilian: "民",
    undercover: "卧",
    blank: "白",
    angel: "天",
  };
  const tone: Record<PlayerRole, string> = {
    civilian: "text-blue-600 bg-blue-50",
    undercover: "text-red-600 bg-red-50",
    blank: "text-stone-500 bg-stone-100",
    angel: "text-amber-600 bg-amber-50",
  };
  return (
    <span
      className={cn("shrink-0 rounded px-1.5 py-px text-[10px] font-semibold leading-none", tone[role])}
    >
      {label[role]}
    </span>
  );
}

interface StatusInfo {
  label: string;
  tone: "default" | "emerald" | "violet" | "red" | "amber";
}

function StatusPill({ label, tone }: StatusInfo) {
  const styles: Record<StatusInfo["tone"], string> = {
    default: "bg-muted text-muted-foreground",
    emerald: "bg-emerald-100 text-emerald-700",
    violet: "bg-violet-100 text-violet-700",
    red: "bg-red-100 text-red-600",
    amber: "bg-amber-100 text-amber-700",
  };
  return (
    <span className={cn("shrink-0 rounded px-1.5 py-px text-[10px] font-medium leading-none", styles[tone])}>
      {label}
    </span>
  );
}

function resolveStatus(
  player: PublicPlayerView,
  waitingPhase: boolean,
  hideSpectatorStatus?: boolean,
): StatusInfo | null {
  if (player.roundStatus === "questioner") return { label: "出题", tone: "violet" };
  if (player.roundStatus === "dead") return { label: "出局", tone: "red" };
  if (player.membership === "spectator" && !hideSpectatorStatus) return { label: "旁观", tone: "default" };
  if (waitingPhase) {
    if (player.isReady) return { label: "准备", tone: "emerald" };
    return { label: "等待", tone: "default" };
  }
  return null;
}
