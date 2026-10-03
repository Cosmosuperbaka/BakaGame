/* eslint-disable react-refresh/only-export-components -- 房主动作需要随 PlayerRow 一起被三个游戏消费，拆文件只会让调用点各写一遍。 */
import type { ReactNode } from "react";
import { motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { ArrowUpRightFromCircle, Bot, Crown, Skull, UserX, WifiOff } from "lucide-react";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Button } from "@/components/ui/Button";
import { PlayerAvatar } from "@/components/common/PlayerAvatar";
import { PLAYER_ME_MARK, PLAYER_ROW_BASE, PLAYER_ROW_HEIGHT } from "@/components/common/PlayerStatusPill";
import { listItem, popover, tappable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/** 玩家行操作浮层里的一个动作。 */
export interface PlayerRowAction {
  icon: ReactNode;
  label: string;
  destructive?: boolean;
  /** 不可执行时禁用：命令执行中，或目标玩家已掉线等 */
  disabled?: boolean;
  onClick: () => void;
}

export interface PlayerRowProps {
  name: string;
  score: number;
  /** 本人：底色与左端竖条同时区分，不只靠颜色 */
  me?: boolean;
  host?: boolean;
  online?: boolean;
  bot?: boolean;
  /** 已出局：名字加删除线，次行补一个图标 */
  eliminated?: boolean;
  /** 次行的状态徽章（身份、准备、猜测中等），由各游戏传入 */
  badges?: ReactNode;
  /** 次行徽章之后的补充文字，如「2 队 · 3/10 次」 */
  meta?: ReactNode;
  /** 第三行整行内容，如 CCB 的猜测进度 */
  detail?: ReactNode;
  /** 操作浮层顶部内容（谁是卧底的身份猜测行） */
  actionsHeader?: ReactNode;
  /** 操作浮层的动作；与 actionsHeader 同为空时整行不可操作 */
  actions?: PlayerRowAction[];
  /** 嵌入发言历史首列时去掉行自身的进出场动画，交由表格统一处理 */
  embedded?: boolean;
}

/**
 * 三游戏共用的玩家行：左端首字头像，中间双行信息（名字与房主标识、状态徽章与补充文字），
 * 右侧分数；有操作权限时整行是可聚焦的原生按钮，点击打开操作浮层。
 *
 * 行高由 `PLAYER_ROW_HEIGHT` 统一，供玩家列与发言历史逐行对齐；嵌入发言历史时不再套动画容器。
 */
export function PlayerRow({
  name, score, me = false, host = false, online = true, bot = false, eliminated = false,
  badges, meta, detail, actionsHeader, actions, embedded = false,
}: PlayerRowProps) {
  const interactive = Boolean(actionsHeader || actions?.length);
  const rowClass = cn(
    PLAYER_ROW_BASE,
    PLAYER_ROW_HEIGHT,
    "gap-2.5",
    me && "bg-primary/10",
    !me && "transition-colors hover:bg-accent/40",
    !online && !bot && "opacity-60",
    // 行贴着滚动区边缘，聚焦环向内收，免得被裁掉。
    interactive && "cursor-pointer focus-visible:-outline-offset-2",
  );

  const body = (
    <>
      {me ? <span className={PLAYER_ME_MARK} /> : null}
      <PlayerAvatar name={name} me={me} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-1">
          <span
            title={name}
            className={cn("min-w-0 truncate font-medium", eliminated && "text-muted-foreground line-through decoration-muted-foreground/60")}
          >
            {name}
          </span>
          {host ? <Crown className="h-3.5 w-3.5 shrink-0 text-warning" aria-label="房主" /> : null}
        </span>
        <span className="flex min-h-4 min-w-0 items-center gap-1">
          {badges}
          {meta}
          {eliminated ? <Skull className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="已出局" /> : null}
          {bot ? (
            <Bot className="h-3.5 w-3.5 shrink-0 text-info" aria-label="测试人机" />
          ) : !online ? (
            <WifiOff className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="已断线" />
          ) : null}
        </span>
        {detail}
      </span>
      <span aria-label={`${score} 分`} className="flex shrink-0 items-baseline gap-0.5 tabular-nums">
        <AnimatedNumber value={score} gain="above" className="text-base leading-none" />
        <span className="font-sans text-2xs text-muted-foreground">分</span>
      </span>
    </>
  );

  const content = interactive ? (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button type="button" variant="ghost" aria-label={`${name} 操作`} className={cn("h-auto justify-start", rowClass)}>
          {body}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="right" align="center" sideOffset={6} collisionPadding={12} asChild>
          <motion.div
            variants={popover}
            initial="initial"
            animate="animate"
            className="z-popover origin-(--radix-popover-content-transform-origin) overflow-hidden floating-surface shadow-md"
          >
            {actionsHeader ? <div className="flex">{actionsHeader}</div> : null}
            {actions?.length ? (
              <div className={cn("flex flex-col", actionsHeader && "border-t")}>
                {actions.map((action) => <PlayerActionButton key={action.label} {...action} />)}
              </div>
            ) : null}
          </motion.div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  ) : <div className={rowClass}>{body}</div>;

  return embedded ? content : (
    <motion.div variants={listItem} initial="initial" animate="animate" exit="exit" layout="position" className="min-w-0">
      {content}
    </motion.div>
  );
}

/** 操作浮层里的动作按钮，与身份猜测行等宽、无缝拼接。 */
export function PlayerActionButton({ icon, label, destructive = false, disabled = false, onClick }: PlayerRowAction) {
  return (
    <Popover.Close asChild>
      <motion.button
        type="button"
        disabled={disabled}
        {...tappable}
        onClick={onClick}
        className={cn(
          "flex w-full items-center gap-2 px-4 py-2.5 text-xs font-medium transition-colors focus-visible:-outline-offset-2",
          "border-t first:border-t-0",
          "disabled:pointer-events-none disabled:opacity-50",
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

/** 转移房主与踢出玩家是三个游戏共有的房主动作。 */
export const hostActions = (handlers: {
  onTransferHost?: () => void;
  /** 目标已掉线等情况下给出禁用原因，动作保留在浮层里但不可点 */
  onKick?: () => void;
  transferDisabled?: boolean;
  kickDisabled?: boolean;
}): PlayerRowAction[] => [
  ...(handlers.onTransferHost
    ? [{ icon: <ArrowUpRightFromCircle className="h-3.5 w-3.5" />, label: "转移房主", disabled: handlers.transferDisabled, onClick: handlers.onTransferHost }]
    : []),
  ...(handlers.onKick
    ? [{ icon: <UserX className="h-3.5 w-3.5" />, label: "踢出玩家", destructive: true, disabled: handlers.kickDisabled, onClick: handlers.onKick }]
    : []),
];
