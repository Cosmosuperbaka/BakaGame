import { useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowUpRightFromCircle,
  Bot,
  Crown,
  Eye,
  EyeOff,
  Skull,
  UserX,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { listContainer, listItem, popover, tappable } from "@/lib/Motion";
import {
  DESCRIPTION_HEAD_TONES,
  DESCRIPTION_TONES,
  descriptionCellShadeForPlayer,
  type DescriptionColumn,
} from "@/lib/DescriptionColumns";
import { PendingSpeech, SubmittedSpeech } from "./PendingSpeech";
import { ROLE_COLORS } from "@/config/WhoIsFakerPresentation";
import { cn } from "@/lib/Utils";
import { PLAYER_BADGE_BASE, PLAYER_ME_MARK, PLAYER_ROW_BASE, PlayerStatusPill } from "./PlayerStatusPill";
import { useWhoIsFakerStore as useGameStore } from "@/stores/UseWhoIsFakerStore";
import {
  buildKnownRoleMap,
  resolveStatus,
  type StatusInfo,
} from "./PlayerPresentation";
import { PLAYER_COLUMN_WIDTH, speechGridTemplate } from "./PlayerListLayout";
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
 * 与投票预览里的身份标签使用同一套纯文字配色。
 * 浅色卡片底承载标签，不再额外绘制彩色边框。
 */
const roleTones: Record<PlayerMark, string> = {
  unknown: "text-muted-foreground",
  civilian: ROLE_COLORS.civilian,
  undercover: ROLE_COLORS.undercover,
  blank: ROLE_COLORS.blank,
  angel: ROLE_COLORS.angel,
};

/**
 * 身份选择器里被选中的那一档。浮层底色是 `bg-background/95`，
 * 半透明色底会被它吃掉，所以这里单独给一套实底。
 */
const roleSelectedTones: Record<PlayerMark, string> = {
  unknown: "bg-muted-foreground/85 text-background",
  civilian: "bg-sky-800 text-white dark:bg-sky-700",
  undercover: "bg-red-900 text-white dark:bg-red-800",
  blank: "bg-stone-700 text-white dark:bg-stone-600",
  angel: "bg-amber-800 text-white dark:bg-amber-700",
};

/** 玩家行与发言历史首栏共用的行高，保证两处对齐 */
export const PLAYER_ROW_HEIGHT = "min-h-10";

/**
 * 玩家列宽度。分界线、行内首列与面板宽度都由此推导。
 * 必须以 rem 表达：全局字号为 120%，1rem 不等于 16px，
 * 写成像素常量会让分界线落进玩家列内部。
 */
export { PLAYER_COLUMN_WIDTH } from "./PlayerListLayout";

/**
 * 发言列的列宽由整列最长的一句决定：`max-content` 取本列所有格子的最大需求宽度，
 * `minmax` 保证短列也不会窄到不可读。
 *
 * 列宽必须跨行一致，因此宽度只能由**同一个** grid 计算。玩家行各自是一层
 * 包裹容器，靠 `grid-template-columns: subgrid` 继承外层的列轨道，
 * 而不是各自再算一遍 —— 否则每行会按自己那一句单独取宽，列就对不齐了。
 */
/** 分组标题行高。展开发言历史时列标题沿用同一高度，保证两侧起始行一致。 */
const PLAYER_GROUP_TITLE_HEIGHT = "1.5rem";

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
  /**
   * 进行中那一列里已提交但尚未公开的玩家。
   * 这些格子显示对勾而不是等待占位 —— 内容已经有了，等的只是揭示时机。
   */
  submittedColumnKey?: string;
  submittedPlayerIds?: Set<string>;
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
  // 出题人视角、死亡公开身份和局后结算身份统一汇入同一份显示真值。
  const roleByPlayerId = buildKnownRoleMap(players, privateState, revealedRoles);
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
    rowIndex: number,
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
    // 列轨道继承自外层 grid，保证同一列在所有行上等宽。
    return (
      <motion.div
        key={player.id}
        variants={listItem}
        initial="initial"
        animate="animate"
        exit="exit"
        layout="position"
        className="col-span-full grid grid-cols-subgrid items-stretch"
      >
        <div className="px-2">
          <PlayerRow {...rowProps} embedded />
        </div>
        {history.columns.map((column) => (
          <SpeechCell
            key={column.key}
            tone={column.tone}
            description={history.byPlayer.get(player.id)?.get(column.key)}
            expected={column.expectedPlayerIds.has(player.id)}
            submitted={
              column.key === history.submittedColumnKey &&
              Boolean(history.submittedPlayerIds?.has(player.id))
            }
            shade={descriptionCellShadeForPlayer(player, rowIndex, column.index)}
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
      <div className="col-span-full grid grid-cols-subgrid items-stretch">
        <div className="px-2">{title}</div>
        {history.columns.map((column) => (
          <div
            key={column.key}
            className={cn(
              "flex items-center whitespace-nowrap px-4 text-[11px] font-semibold tracking-wide",
              withRule && "mt-3",
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
  // 展开历史时分组容器只负责纵向排布，列轨道由最外层 grid 统一持有。
  const groupClass = history
    ? "col-span-full grid grid-cols-subgrid gap-y-px"
    : "flex flex-col gap-px";
  // 斑马纹按整张表连续计数，跨分组也不会在交界处出现两行同色。
  const observerRowOffset = activePlayers.length;
  const departedRowOffset = observerRowOffset + observers.length;

  const body = (
    <div
      className={cn(
        "relative py-2",
        history ? "grid min-h-full w-max min-w-full content-start" : "flex flex-col",
      )}
      style={
        history
          ? { gridTemplateColumns: speechGridTemplate(history.columns.length) }
          : undefined
      }
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
        className={groupClass}
        variants={listContainer(activePlayers.length)}
        initial={false}
        animate="animate"
      >
        <AnimatePresence initial={false} mode="popLayout">
          {activePlayers.map((player, index) => renderRow(player, false, index))}
        </AnimatePresence>
      </motion.div>

      {showSpectatorToggle && isSpectator ? (
        <SpectatorToggle spectator={false} onToggle={handleSetSpectator} />
      ) : null}

      {observers.length > 0 || (showSpectatorToggle && !isSpectator) ? (
        <>
          {renderGroupTitle("旁观", observers.length, true)}
          <motion.div
            className={groupClass}
            variants={listContainer(observers.length)}
            initial={false}
            animate="animate"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {observers.map((player, index) =>
                renderRow(player, true, observerRowOffset + index),
              )}
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
          <div className={groupClass}>
            {departed.map((player, index) =>
              renderRow(player, true, departedRowOffset + index, { readOnly: true }),
            )}
          </div>
        </>
      ) : null}
    </div>
  );

  // 展开后玩家列和发言列必须共享同一个双向滚动容器，才能保持行对齐；
  // 外层面板只负责裁切动画范围，不会替这里提供滚动。
  if (history) {
    return (
      <div
        data-testid="player-history-scroll"
        className="scrollbar-hidden h-full min-h-0 overflow-auto"
      >
        {body}
      </div>
    );
  }
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
  submitted,
  shade,
}: {
  description?: DescriptionRecord;
  tone: DescriptionColumn["tone"];
  expected: boolean;
  /** 已提交但顺序未到，内容仍折起 */
  submitted?: boolean;
  /** 棋盘格底色，由所在行列的奇偶决定 */
  shade?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center px-4 py-1.5 text-sm leading-relaxed",
        DESCRIPTION_TONES[tone],
        shade,
      )}
    >
      {/* 列宽已按本列最长发言取值，因此单行不再换行 */}
      {description ? (
        <span className="whitespace-nowrap">{description.text}</span>
      ) : submitted ? (
        <SubmittedSpeech />
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
      className={cn("flex items-center gap-2 px-2", withRule && "mt-3")}
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
        PLAYER_ROW_BASE,
        PLAYER_ROW_HEIGHT,
        isMe && "bg-primary/10",
        !isMe && "transition-colors hover:bg-accent/50",
        // 机器人没有连接，但不是「掉线」，不该被压暗
        !player.online && !player.isBot && "opacity-60",
        interactive && "cursor-pointer",
      )}
    >
      {isMe ? (
        <span className={PLAYER_ME_MARK} />
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
      {/* 出局与房主、掉线同属玩家标记，共用名字之后这一处图标位 */}
      {eliminated ? (
        <Skull className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="已出局" />
      ) : null}
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
          ? roleSelectedTones[option]
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

/** 身份标签；预测身份使用略淡底色，真实身份沿用投票预览的标准底色。 */
function RoleBadge({ role, predicted }: { role: PlayerMark; predicted?: boolean }) {
  return (
    <span
      className={cn(PLAYER_BADGE_BASE, roleTones[role], predicted && "bg-muted/70")}
      aria-label={predicted ? `预测 ${roleLabels[role]}` : roleLabels[role]}
    >
      {roleLabels[role]}
    </span>
  );
}

/** 主持、出局、旁观与准备状态。与身份徽章同尺寸同实底，行首一致。 */
function StatusPill({ label, tone }: StatusInfo) {
  return <PlayerStatusPill label={label} tone={tone} />;
}
