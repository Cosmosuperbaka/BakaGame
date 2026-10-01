import { cn } from "@/lib/Utils";

export type PlayerStatusTone = "default" | "success" | "questioner" | "warning" | "danger";

/** 玩家行统一行高，保证各面板对齐 */
export const PLAYER_ROW_HEIGHT = "min-h-14";

/**
 * 玩家列宽度（16rem）。同时用于面板、网格首列与分界线定位。
 * 必须以 rem 表达：全局字号为 120%，1rem 不等于 16px。
 */
export const PLAYER_COLUMN_WIDTH = "16rem";

/** 分组标题行高，展开历史时列标题沿用同一高度 */
export const PLAYER_GROUP_TITLE_HEIGHT = "1.5rem";

/** 浅底徽章基底类名：各游戏玩家栏的状态徽章与谁是卧底的身份徽章（`RoleBadge`）共用 */
export const PLAYER_BADGE_BASE =
  "inline-flex shrink-0 items-center justify-center rounded-md bg-muted px-1.5 py-0.5 font-sans text-2xs font-normal leading-none tracking-normal";

/** 玩家栏共用的行布局基底；游戏房间在此基础上追加自身状态 */
export const PLAYER_ROW_BASE =
  "relative flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pl-2.5 pr-2 text-left text-sm";

/** 本人标识指示条 */
export const PLAYER_ME_MARK =
  "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary";

/**
 * 状态色调。含义固定：默认=中性等待，success=成功/完成，questioner=出题人，
 * warning=提示，danger=危险/淘汰。取语义令牌而非调色板色阶，
 * 暗色变体由令牌自身携带，不再逐处补 `dark:`。
 */
const PLAYER_STATUS_TONES: Record<PlayerStatusTone, string> = {
  default: "text-muted-foreground",
  success: "text-success",
  questioner: "text-questioner",
  warning: "text-warning",
  danger: "text-destructive",
};

/** 统一状态胶囊徽章 */
export function PlayerStatusPill({
  label,
  tone,
}: {
  label: string;
  tone: PlayerStatusTone;
}) {
  return <span className={cn(PLAYER_BADGE_BASE, PLAYER_STATUS_TONES[tone])}>{label}</span>;
}

/** 跨游戏通用的玩家分组标题（如“玩家 (4)”、“旁观 (1)”） */
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
      <h3 className="font-sans text-2xs font-normal tracking-wide text-muted-foreground">
        {label}
      </h3>
      <span className="font-sans text-2xs font-normal tabular-nums text-muted-foreground">
        {count}
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}
