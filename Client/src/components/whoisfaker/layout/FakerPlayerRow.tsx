import type { Ref } from "react";
import { motion } from "framer-motion";
import { PlayerRow as PlayerRowBase, hostActions } from "@/components/common/PlayerRow";
import { AgentBadge, McpControlledBadge } from "@/components/common/AgentBadge";
import { PlayerStatusIcon } from "@/components/common/PlayerStatusPill";
import { ROLE_LABELS } from "@/config/WhoIsFakerPresentation";
import { tappable } from "@/lib/motion/Feedback";
import { cn } from "@/lib/Utils";
import { FakerRoleBadge } from "./FakerRoleBadge";
import { resolveStatus } from "./FakerPlayerPresentation";
import type { PublicPlayerView, WhoIsFakerRole } from "@bakagame/shared";

export type PlayerMark = "unknown" | WhoIsFakerRole;
export type PlayerMarks = Record<string, PlayerMark>;

/** 身份选择器上的双字：真实身份沿用 `ROLE_LABELS`，只多一档「未知」 */
const roleLabels: Record<PlayerMark, string> = { unknown: "未知", ...ROLE_LABELS };

/**
 * 身份选择器里被选中的那一档。浮层底色是 `bg-background/95`，
 * 半透明色底会被它吃掉，所以这里单独给一套实底：
 * 底色取状态令牌本身，前景取配套的 `-foreground`，两档同源于一套取值。
 */
const roleSelectedTones: Record<PlayerMark, string> = {
  unknown: "bg-muted-foreground/85 text-background",
  civilian: "bg-info text-info-foreground",
  undercover: "bg-destructive text-destructive-foreground",
  blank: "bg-muted-foreground text-background",
  angel: "bg-warning text-warning-foreground",
};

export interface PlayerRowProps {
  player: PublicPlayerView;
  myPlayerId?: string;
  isHostViewer: boolean;
  waitingPhase: boolean;
  hideSpectatorStatus?: boolean;
  actualRole?: WhoIsFakerRole;
  mark: PlayerMark;
  canMark: boolean;
  availableMarks: PlayerMark[];
  onMarkChange: (playerId: string, mark: PlayerMark) => void;
  onKick: (playerId: string) => void;
  onTransferHost: (playerId: string) => void;
  /** 嵌入发言历史首栏时去掉行自身的进出场动画，交由表格统一处理 */
  embedded?: boolean;
  /** 转交给通用行的动画容器，供 `popLayout` 抽出退场行 */
  ref?: Ref<HTMLDivElement>;
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
    ref,
  } = props;

  const isMe = player.id === myPlayerId;
  const canManage = isHostViewer && !isMe;
  const eliminated = player.roundStatus === "dead";
  const status = resolveStatus(player, waitingPhase, hideSpectatorStatus);

  return (
    <PlayerRowBase
      name={player.name}
      score={player.score}
      me={isMe}
      host={player.isHost}
      online={player.online}
      bot={player.isBot}
      account={player.account}
      eliminated={eliminated}
      badges={
        <>
          {player.isAgent ? <AgentBadge /> : null}
          {player.mcpControlled ? <McpControlledBadge /> : null}
          {actualRole ? (
            <FakerRoleBadge role={actualRole} />
          ) : mark !== "unknown" ? (
            <FakerRoleBadge role={mark} predicted />
          ) : null}
          {status ? <PlayerStatusIcon tone={status.tone} label={status.label} /> : null}
        </>
      }
      embedded={embedded}
      layoutId={embedded ? undefined : player.id}
      ref={ref}
      {...(canMark
        ? {
            actionsHeader: availableMarks.map((option, idx) => (
              <MarkButton
                key={option}
                option={option}
                selected={mark === option}
                first={idx === 0}
                last={idx === availableMarks.length - 1}
                onSelect={() => onMarkChange(player.id, option)}
              />
            )),
          }
        : {})}
      {...(canManage
        ? {
            actions: hostActions({
              onTransferHost: () => onTransferHost(player.id),
              onKick: () => onKick(player.id),
            }),
          }
        : {})}
    />
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
        last && "rounded-tr-[calc(var(--radius)-1px)]"
      )}
    >
      {roleLabels[option]}
    </motion.button>
  );
}
