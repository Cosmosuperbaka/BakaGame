import { useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { ArrowUpRightFromCircle, Bot, Crown, Eye, EyeOff, UserX, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { listContainer, listItem, popover, tappable } from "@/lib/motion";
import {
  DESCRIPTION_HEAD_TONES,
  DESCRIPTION_TONES,
  type DescriptionColumn,
} from "@/lib/descriptionColumns";
import { PendingSpeech } from "@/components/game/PendingSpeech";
import { cn } from "@/lib/utils";
import { useGameStore } from "@/stores/useGameStore";
import type {
  DescriptionRecord,
  GamePhase,
  PlayerRole,
  PrivateState,
  PublicPlayerView,
  RoleConfig,
} from "@/types";

export type PlayerMark = "unknown" | PlayerRole;
export type PlayerMarks = Record<string, PlayerMark>;

/** 身份徽章上的双字，身份标与身份预测共用 */
const roleLabels: Record<PlayerMark, string> = {
  unknown: "未知",
  civilian: "平民",
  undercover: "卧底",
  blank: "白板",
  angel: "天使",
};

/**
 * 身份配色。已确认的身份用实底，预测用同色系描边，
 * 两者一眼可分，不靠位置区分。
 */
const roleTones: Record<PlayerMark, { solid: string; outline: string }> = {
  unknown: {
    solid: "bg-muted text-muted-foreground",
    outline: "border-border text-muted-foreground",
  },
  civilian: {
    solid: "bg-blue-600 text-white dark:bg-blue-500",
    outline: "border-blue-500/60 text-blue-700 dark:text-blue-300",
  },
  undercover: {
    solid: "bg-red-600 text-white dark:bg-red-500",
    outline: "border-red-500/60 text-red-700 dark:text-red-300",
  },
  blank: {
    solid: "bg-stone-500 text-white dark:bg-stone-400 dark:text-stone-950",
    outline: "border-stone-400/70 text-stone-600 dark:text-stone-300",
  },
  angel: {
    solid: "bg-amber-500 text-white dark:text-amber-950",
    outline: "border-amber-500/60 text-amber-700 dark:text-amber-300",
  },
};

/**
 * 状态徽章配色。与身份徽章同为实底：
 * 低透明度底色下准备、等待这类高频状态几乎看不出来。
 */
const statusTones: Record<StatusInfo["tone"], string> = {
  default: "bg-secondary text-secondary-foreground",
  emerald: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950",
  violet: "bg-violet-600 text-white dark:bg-violet-500 dark:text-violet-950",
  red: "bg-red-600 text-white dark:bg-red-500 dark:text-red-950",
  amber: "bg-amber-500 text-white dark:text-amber-950",
};

/**
 * 行首徽章的共同几何。身份、主持与准备状态共用同一套尺寸与字重，
 * 宽度固定为双字所需，使各行行首严格对齐。
 */
const BADGE_BASE =
  "inline-flex h-5 w-10 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold leading-none tracking-normal";

/** 玩家行与发言历史首栏共用的行高，保证两处对齐 */
export const PLAYER_ROW_HEIGHT = "min-h-11";

/**
 * 玩家列宽度。分界线、行内首列与面板宽度都由此推导。
 * 必须以 rem 表达：全局字号为 120%，1rem 不等于 16px，
 * 写成像素常量会让分界线落进玩家列内部。
 */
export const PLAYER_COLUMN_WIDTH = "16rem";

/** 单个发言列的最小宽度（px），与单元格上的 min-w 保持一致 */
const SPEECH_COLUMN_MIN_WIDTH = 200;

/** 分组标题行高。展开发言历史时列标题沿用同一高度，保证两侧起始行一致。 */
const PLAYER_GROUP_TITLE_HEIGHT = "1.75rem";

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
  /** 结算后公开的身份，叠加在出题人视角之上 */
  revealedRoles?: Map<string, PlayerRole>;
  /**
   * 展开发言历史时传入。
   * 发言单元格直接渲染进玩家行内，对齐由 DOM 结构保证，
   * 不依赖两侧各自复刻行高与间距。
   */
  history?: PlayerListHistory;
}

/** 玩家行右侧续接的发言列 */
export interface PlayerListHistory {
  columns: DescriptionColumn[];
  byPlayer: Map<string, Map<string, DescriptionRecord>>;
  /** 只在发言记录里出现、已离场的玩家，附在旁观分组之后 */
  departedPlayers: PublicPlayerView[];
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
    revealedRoles,
    history,
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
  // 出题人视角的身份，叠加结算后公开的身份。
  const roleByPlayerId = new Map(
    (privateState?.questionerView ?? []).map((entry) => [entry.playerId, entry.role]),
  );
  if (revealedRoles) {
    for (const [playerId, role] of revealedRoles) roleByPlayerId.set(playerId, role);
  }
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

  /**
   * 渲染一行。展开发言历史时，玩家名与该行的发言单元格是同一个
   * flex 行的两部分，因此天然等高对齐。
   */
  const renderRow = (
    player: PublicPlayerView,
    hideSpectatorStatus: boolean,
    options?: { readOnly?: boolean },
  ) => {
    const rowProps: PlayerRowProps = {
      player,
      myPlayerId,
      isHostViewer: isHost,
      waitingPhase,
      hideSpectatorStatus,
      actualRole: roleByPlayerId.get(player.id),
      mark: playerMarks[player.id] ?? "unknown",
      canMark: Boolean(
        !options?.readOnly &&
          canMarkPlayers &&
          player.membership === "active" &&
          player.roundStatus !== "questioner",
      ),
      availableMarks,
      onMarkChange,
      onKick: handleKick,
      onTransferHost: handleTransferHost,
    };

    // 未展开历史时 PlayerRow 自带进出场动画，直接返回。
    if (!history) return <PlayerRow key={player.id} {...rowProps} />;

    // 展开后由外层承担进出场，行内首列去掉自身动画以免双重变换。
    return (
      <motion.div
        key={player.id}
        variants={listItem}
        initial="initial"
        animate="animate"
        exit="exit"
        layout="position"
        className="flex items-stretch"
      >
        <div className="shrink-0 px-2" style={{ width: PLAYER_COLUMN_WIDTH }}>
          <PlayerRow {...rowProps} embedded />
        </div>
        {history.columns.map((column) => (
          <SpeechCell
            key={column.key}
            tone={column.tone}
            description={history.byPlayer.get(player.id)?.get(column.key)}
            expected={column.expectedPlayerIds.has(player.id)}
          />
        ))}
      </motion.div>
    );
  };

  /** 分组标题行。展开历史时右侧续接列标题，与首列同高。 */
  const renderGroupTitle = (label: string, count: number, withRule: boolean) => {
    const title = <PlayerGroupTitle label={label} count={count} withRule={withRule} />;
    if (!history) return title;
    return (
      <div className="flex items-stretch">
        <div className="shrink-0 px-2" style={{ width: PLAYER_COLUMN_WIDTH }}>
          {title}
        </div>
        {history.columns.map((column) => (
          <div
            key={column.key}
            className={cn(
              "flex min-w-[200px] flex-1 items-center px-4 text-[11px] font-semibold tracking-wide",
              withRule && "mt-4",
              DESCRIPTION_HEAD_TONES[column.tone],
            )}
            style={{ height: PLAYER_GROUP_TITLE_HEIGHT }}
          >
            {/* 列标题只在第一组显示，第二组留空避免重复 */}
            {withRule ? null : column.label}
          </div>
        ))}
      </div>
    );
  };

  const departed = history?.departedPlayers ?? [];

  const body = (
    <div
      className={cn("relative flex flex-col py-3", history && "min-h-full")}
      style={{
        minWidth: history
          ? `calc(${PLAYER_COLUMN_WIDTH} + ${history.columns.length * SPEECH_COLUMN_MIN_WIDTH}px)`
          : undefined,
      }}
    >
      {/* 玩家列与发言列的分界线。整列贯穿到底，不随最后一行结束，
          否则行间距与列表末尾的空白处会把线断开。
          位置必须与行内首列取同一个宽度值，用 rem 而非像素常量，
          否则 120% 全局字号会让线落进玩家列内部。 */}
      {history ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-px bg-border"
          style={{ left: PLAYER_COLUMN_WIDTH }}
        />
      ) : null}
      {renderGroupTitle("玩家", activePlayers.length, false)}
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
          {renderGroupTitle("旁观", observers.length, true)}
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

      {/* 已离场但本局有发言记录的玩家，只读展示 */}
      {departed.length > 0 ? (
        <>
          {renderGroupTitle("已离场", departed.length, true)}
          <div className="flex flex-col gap-px">
            {departed.map((player) => renderRow(player, true, { readOnly: true }))}
          </div>
        </>
      ) : null}
    </div>
  );

  // 展开历史时纵向滚动交给外层共享容器，避免两侧各自滚动。
  if (history) return body;
  return (
    <ScrollArea className="h-full">
      <div className="px-2">{body}</div>
    </ScrollArea>
  );
}

/**
 * 玩家行右侧的发言单元格。
 * 只有本列确实该发言的玩家才在未提交时显示等待占位；
 * 出题人、旁观者与本列无需发言的玩家留空。
 */
function SpeechCell({
  description,
  tone,
  expected,
}: {
  description?: DescriptionRecord;
  tone: DescriptionColumn["tone"];
  expected: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-[200px] flex-1 items-center px-4 py-1.5 text-sm leading-relaxed",
        DESCRIPTION_TONES[tone],
      )}
    >
      {description ? (
        <span className="break-words">{description.text}</span>
      ) : expected ? (
        <PendingSpeech />
      ) : null}
    </div>
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
    <div
      className={cn("flex items-center gap-2 px-2", withRule && "mt-4")}
      style={{ height: PLAYER_GROUP_TITLE_HEIGHT }}
    >
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
  const canManage = isHostViewer && !isMe;
  const interactive = canMark || canManage;
  const eliminated = player.roundStatus === "dead";
  const status = resolveStatus(player, waitingPhase, hideSpectatorStatus);

  const body = (
    <div
      className={cn(
        "relative flex w-full items-center gap-1.5 rounded-md py-1.5 pl-3 pr-2.5 text-left text-sm",
        PLAYER_ROW_HEIGHT,
        isMe && "bg-primary/10",
        !isMe && interactive && "hover:bg-accent/50",
        // 机器人没有连接，但不是「掉线」，不该被压暗
        !player.online && !player.isBot && "opacity-60",
        interactive && "cursor-pointer",
      )}
    >
      {isMe ? (
        <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
      ) : null}
      {/* 身份与状态全部落在名字之前：已知身份优先，其次自己的预测 */}
      {actualRole ? (
        <RoleBadge role={actualRole} />
      ) : mark !== "unknown" ? (
        <RoleBadge role={mark} predicted />
      ) : null}
      {status ? <StatusPill tone={status.tone} label={status.label} /> : null}
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-medium",
          eliminated && "text-muted-foreground line-through decoration-muted-foreground/60",
        )}
      >
        {player.name}
      </span>
      {player.isHost ? (
        <Crown className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="房主" />
      ) : null}
      {/* 机器人标注为人机，而不是复用断线图标 */}
      {player.isBot ? (
        <Bot className="h-3.5 w-3.5 shrink-0 text-sky-500" aria-label="测试人机" />
      ) : !player.online ? (
        <WifiOff className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="已断线" />
      ) : null}
      {/* 得分居右 */}
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {player.score}<span className="ml-0.5 text-[10px]">分</span>
      </span>
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
          sideOffset={6}
          collisionPadding={12}
          asChild
        >
          <motion.div
            variants={popover}
            initial="initial"
            animate="animate"
            className="z-[80] overflow-hidden rounded-md border bg-background/95 shadow-md backdrop-blur-md"
          >
            {/* 身份猜测行：与下方管理按钮等宽，无缝 */}
            {canMark ? (
              <div className="flex">
                {availableMarks.map((option, idx) => (
                  <MarkButton
                    key={option}
                    option={option}
                    selected={mark === option}
                    first={idx === 0}
                    last={idx === availableMarks.length - 1}
                    onSelect={() => onMarkChange(player.id, option)}
                  />
                ))}
              </div>
            ) : null}
            {/* 管理操作：两行，无缝拼接 */}
            {canManage ? (
              <div className={cn("flex flex-col", canMark && "border-t")}>
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
  first,
  last,
  onSelect,
}: {
  option: PlayerMark;
  selected: boolean;
  first?: boolean;
  last?: boolean;
  onSelect: () => void;
}) {
  return (
    <motion.button
      {...tappable}
      aria-label={roleLabels[option]}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex flex-1 items-center justify-center whitespace-nowrap px-3 py-2 text-xs font-semibold transition-colors",
        "border-r last:border-r-0",
        selected
          ? roleTones[option].solid
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        first && "rounded-tl-[calc(var(--radius)-1px)]",
        last && "rounded-tr-[calc(var(--radius)-1px)]",
      )}
    >
      {roleLabels[option]}
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

/**
 * 身份徽章。`predicted` 为本人的猜测，用描边表达“尚未确认”；
 * 实底表示出题人视角或结算后公开的真实身份。
 */
function RoleBadge({ role, predicted }: { role: PlayerMark; predicted?: boolean }) {
  const tone = roleTones[role];
  return (
    <span
      className={cn(BADGE_BASE, predicted ? cn("border border-dashed", tone.outline) : tone.solid)}
      aria-label={predicted ? `预测 ${roleLabels[role]}` : roleLabels[role]}
    >
      {roleLabels[role]}
    </span>
  );
}

interface StatusInfo {
  label: string;
  tone: "default" | "emerald" | "violet" | "red" | "amber";
}

/** 主持、出局、旁观与准备状态。与身份徽章同尺寸同实底，行首一致。 */
function StatusPill({ label, tone }: StatusInfo) {
  return <span className={cn(BADGE_BASE, statusTones[tone])}>{label}</span>;
}

function resolveStatus(
  player: PublicPlayerView,
  waitingPhase: boolean,
  hideSpectatorStatus?: boolean,
): StatusInfo | null {
  if (player.roundStatus === "questioner") return { label: "主持", tone: "violet" };
  if (player.roundStatus === "dead") return { label: "出局", tone: "red" };
  if (player.membership === "spectator" && !hideSpectatorStatus) return { label: "旁观", tone: "default" };
  if (waitingPhase) {
    if (player.isReady) return { label: "准备", tone: "emerald" };
    return { label: "等待", tone: "default" };
  }
  return null;
}
