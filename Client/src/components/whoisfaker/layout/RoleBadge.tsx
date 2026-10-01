import { PLAYER_BADGE_BASE } from "@/components/common/PlayerStatusPill";
import { ROLE_COLORS, ROLE_LABELS } from "@/config/WhoIsFakerPresentation";
import { cn } from "@/lib/Utils";
import type { PlayerRole } from "@/types";

/**
 * 双字身份徽章，玩家栏、出题人的中盘预览与结算身份表共用。
 * 与状态徽章同一基底，身份只靠 `ROLE_COLORS` 的文字色区分。
 */
export function RoleBadge({
  role,
  predicted = false,
  inset = false,
}: {
  role: PlayerRole;
  /** 本人的身份预测：淡色块表达“未确认”，读屏另读出「预测」 */
  predicted?: boolean;
  /** 放在 `bg-muted` 实色块上（预览卡片、结算表）时换成页面底，否则徽章与所在块同色 */
  inset?: boolean;
}) {
  return (
    <span className={cn(PLAYER_BADGE_BASE, ROLE_COLORS[role], inset && "bg-background", predicted && "bg-muted/40")}>
      {predicted ? <span className="sr-only">预测</span> : null}
      {ROLE_LABELS[role]}
    </span>
  );
}
