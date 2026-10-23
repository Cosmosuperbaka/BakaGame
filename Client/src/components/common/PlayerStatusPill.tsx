import { useId, type ReactNode } from "react";
import { LayoutGroup, motion } from "framer-motion";
import {
  CircleCheck,
  CircleHelp,
  CircleMinus,
  Clapperboard,
  Clock,
  Eye,
  Flag,
  Headphones,
  Music,
  PenLine,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { Hint } from "@/components/ui/Tooltip";
import { playerRelayout } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

export type PlayerStatusTone = "default" | "success" | "questioner" | "warning" | "danger";

/** 玩家行统一行高：头像加首行名字与次行状态刚好，八人以上的房间也能一屏放下 */
export const PLAYER_ROW_HEIGHT = "min-h-11";

/**
 * 玩家列宽度（16rem）。同时用于面板、网格首列与分界线定位。
 * 必须以 rem 表达：全局字号为 120%，1rem 不等于 16px。
 */
export const PLAYER_COLUMN_WIDTH = "16rem";

/** 分组标题行高，展开历史时列标题沿用同一高度 */
export const PLAYER_GROUP_TITLE_HEIGHT = "1.25rem";

/** 徽章基底类名：各游戏玩家栏的状态徽章与谁是卧底的身份徽章（`RoleBadge`）共用，底色由各自色调给 */
export const PLAYER_BADGE_BASE =
  "inline-flex shrink-0 items-center justify-center gap-1 rounded-md px-1.5 py-0.5 font-sans text-2xs font-normal leading-none tracking-normal";

/** 玩家栏共用的行布局基底；游戏房间在此基础上追加自身状态 */
export const PLAYER_ROW_BASE =
  "relative flex w-full min-w-0 items-center gap-2 rounded-md py-1 pl-2.5 pr-2 text-left text-sm";

/** 本人标识指示条 */
export const PLAYER_ME_MARK =
  "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary";

/**
 * 状态色调。含义固定：默认=中性等待，success=成功/完成，questioner=出题人，
 * warning=提示，danger=危险/淘汰。取语义令牌而非调色板色阶，
 * 暗色变体由令牌自身携带，不再逐处补 `dark:`。
 * 底部淡色底让「准备」「离线」这类关键状态不必逐字阅读也能扫到。
 */
const PLAYER_STATUS_TONES: Record<PlayerStatusTone, string> = {
  default: "bg-muted text-muted-foreground",
  success: "bg-success/15 text-success",
  questioner: "bg-questioner/15 text-questioner",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/15 text-destructive",
};

/**
 * 状态文字 → 图标。三个游戏的状态名都取自各自的阶段语义，这里给一份共用映射，
 * 同一件状态在猜歌、猜猜呗与谁是卧底里才是同一个字形；认不出的新状态回退成一枚空心圆，
 * 不硬猜语义，也绝不出现「有底块没图标」的空格。
 */
const PLAYER_STATUS_ICONS: Record<string, LucideIcon> = {
  准备: CircleCheck,
  等待: Clock,
  出题: PenLine,
  主持: PenLine,
  猜歌: Music,
  猜番: Clapperboard,
  听音: Headphones,
  观战: Eye,
  旁观: Eye,
  猜中: Trophy,
  完成: Flag,
  未猜中: CircleMinus,
};

/** 图标档只占图标本身的宽度：不铺底块、不定死方块尺寸，跟名字与徽章同一条基线排。 */
const PLAYER_STATUS_ICON_BASE = "inline-flex shrink-0 items-center [&_svg]:size-4";

/** 图标档只取色调文字色，不铺底块：玩家行本来就密，给每枚状态加一块纯色方砖只会更吵。 */
const PLAYER_STATUS_ICON_TONES: Record<PlayerStatusTone, string> = {
  default: "text-muted-foreground",
  success: "text-success",
  questioner: "text-questioner",
  warning: "text-warning",
  danger: "text-destructive",
};

/**
 * 状态图标：玩家栏要扫得快，房主、准备、离线这类状态收成一枚图标。
 *
 * 图标不是唯一的线索——同一份文字仍在 DOM 里：`sr-only` 给读屏，`Hint` 给悬停，
 * 形状与色调给视觉。所以「只靠颜色传达」这条红线没有被触碰，被拿掉的只是常驻可见的字。
 * `icon` 省略时按 `label` 取共用映射，三个游戏因此对同一状态用同一字形。
 */
export function PlayerStatusIcon({
  label,
  tone,
  icon,
}: {
  label: string;
  tone: PlayerStatusTone;
  icon?: ReactNode;
}) {
  const Glyph = PLAYER_STATUS_ICONS[label] ?? CircleHelp;
  return (
    <Hint label={label}>
      <span className={cn(PLAYER_STATUS_ICON_BASE, PLAYER_STATUS_ICON_TONES[tone])}>
        {icon ?? <Glyph aria-hidden="true" />}
        <span className="sr-only">{label}</span>
      </span>
    </Hint>
  );
}

/** 统一状态胶囊徽章；`icon` 只作状态补充，文字始终保留，不单靠图标或颜色传达状态。 */
export function PlayerStatusPill({
  label,
  tone,
  icon,
}: {
  label: string;
  tone: PlayerStatusTone;
  icon?: ReactNode;
}) {
  return (
    <span className={cn(PLAYER_BADGE_BASE, PLAYER_STATUS_TONES[tone])}>
      {icon}
      {label}
    </span>
  );
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
    <motion.div
      layout="position"
      transition={playerRelayout}
      className={cn("flex items-center gap-2 px-2", withRule && "mt-1.5")}
      style={{ height: PLAYER_GROUP_TITLE_HEIGHT }}
    >
      <h3 className="font-sans text-2xs font-normal text-muted-foreground">{label}</h3>
      <span className="font-sans text-2xs font-normal tabular-nums text-muted-foreground">
        {count}
      </span>
      <span className="h-px flex-1 bg-border" />
    </motion.div>
  );
}

/**
 * 一份玩家栏的布局作用域：行（`PlayerRow layoutId`）、分组标题与旁观切换入口在同一组里联动，
 * 有人在玩家与旁观之间换组时，行滑到新位置，下方的标题与入口跟着让位，不跳。
 * 每个实例单独命名，桌面侧栏与窄屏抽屉同时挂载时互不串台。
 */
export function PlayerListLayout({ children }: { children: ReactNode }) {
  return <LayoutGroup id={useId()}>{children}</LayoutGroup>;
}
