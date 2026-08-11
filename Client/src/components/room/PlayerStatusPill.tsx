import { cn } from "@/lib/utils";

export type PlayerStatusTone = "default" | "emerald" | "violet" | "red" | "amber";

/** 玩家栏统一使用的浅底状态徽章；Whoisfaker 与 Songuessr 共用这一套样式。 */
export const PLAYER_BADGE_BASE =
  "inline-flex shrink-0 items-center justify-center rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold leading-none tracking-normal";

/** 玩家栏共用的行布局；游戏房间只需在此基础上追加自己的状态内容。 */
export const PLAYER_ROW_BASE =
  "relative flex w-full items-center gap-1 rounded-md py-1 pl-2.5 pr-2 text-left text-sm";
export const PLAYER_ME_MARK =
  "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary";

const PLAYER_STATUS_TONES: Record<PlayerStatusTone, string> = {
  default: "text-muted-foreground",
  emerald: "text-emerald-600",
  violet: "text-purple-600",
  red: "text-red-600",
  amber: "text-amber-600",
};

export function PlayerStatusPill({
  label,
  tone,
}: {
  label: string;
  tone: PlayerStatusTone;
}) {
  return <span className={cn(PLAYER_BADGE_BASE, PLAYER_STATUS_TONES[tone])}>{label}</span>;
}
