import { useEffect, useState, type ReactNode } from "react";
import { badgeDescriptionOf, badgeLabelOf } from "@bakagame/shared/values";
import type { AccountBadge, BadgeKind, PlayerAccount } from "@bakagame/shared";
import { PLAYER_BADGE_BASE } from "@/components/common/PlayerStatusPill";
import { Hint } from "@/components/ui/Tooltip";
import { loadPublicProfile } from "@/lib/ProfileCache";
import { useAccountStore } from "@/stores/UseAccountStore";
import { cn } from "@/lib/Utils";

/**
 * 账号身份徽章：与游戏状态徽章分开一层中性描边，不占用 success / warning 等状态语义。
 * 文字始终保留，不单靠颜色表达；悬停给出徽章描述。
 */
export function BadgeChip({ badge, className }: { badge: AccountBadge; className?: string }) {
  const label = badgeLabelOf(badge);
  const description = badgeDescriptionOf(badge);
  return (
    <Hint label={description}>
      <span
        aria-label={`${label}：${description}`}
        className={cn(
          PLAYER_BADGE_BASE,
          "border border-border bg-background/60 text-muted-foreground",
          className
        )}
      >
        {label}
      </span>
    </Hint>
  );
}

/** 全部已获得徽章，后台与徽章管理列表使用；空列表不渲染任何占位。 */
export function BadgeList({
  badges,
  className,
}: {
  badges: readonly AccountBadge[];
  className?: string;
}) {
  if (!badges.length) return null;
  return (
    <span className={cn("flex shrink-0 flex-wrap items-center gap-0.5", className)}>
      {badges.map((badge) => (
        <BadgeChip key={badge.kind} badge={badge} />
      ))}
    </span>
  );
}

/** 佩戴中的那一枚；没有佩戴、或佩戴的徽章已不在列表里时不渲染。 */
export function EquippedBadge({
  badges,
  equipped,
}: {
  badges: readonly AccountBadge[];
  equipped: BadgeKind | null;
}): ReactNode {
  const badge = equipped ? badges.find((item) => item.kind === equipped) : undefined;
  return badge ? <BadgeChip badge={badge} /> : null;
}

/**
 * 玩家行昵称旁的徽章：本人直接读账号资料，其他玩家按用户 ID 走公开资料缓存。
 * 只展示当前佩戴的一枚；徽章不进房间快照，读取失败静默留空，不挡玩家行。
 */
export function PlayerBadges({ account }: { account: PlayerAccount }): ReactNode {
  const own = useAccountStore((state) => state.profile);
  const isSelf = own?.id === account.userId;
  // 异步结果连同用户 ID 一起存：本人或换人后旧结果自然失效，不必在 effect 里同步清 state。
  const [loaded, setLoaded] = useState<{
    userId: string;
    badges: readonly AccountBadge[];
    equipped: BadgeKind | null;
  } | null>(null);

  useEffect(() => {
    if (isSelf) return;
    let alive = true;
    loadPublicProfile(account.userId).then(
      (profile) => {
        if (alive)
          setLoaded({
            userId: account.userId,
            badges: profile.badges,
            equipped: profile.equippedBadge,
          });
      },
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [account.userId, isSelf]);

  if (own?.id === account.userId)
    return <EquippedBadge badges={own.badges} equipped={own.equippedBadge} />;
  return loaded?.userId === account.userId ? (
    <EquippedBadge badges={loaded.badges} equipped={loaded.equipped} />
  ) : null;
}
