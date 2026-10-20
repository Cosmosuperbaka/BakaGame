import { useEffect, useState, type ReactNode } from "react";
import { BADGE_LABELS, type BadgeKind, type PlayerAccount } from "@bakagame/shared";
import { PLAYER_BADGE_BASE } from "@/components/common/PlayerStatusPill";
import { loadPublicProfile } from "@/lib/ProfileCache";
import { useAccountStore } from "@/stores/UseAccountStore";
import { cn } from "@/lib/Utils";

/**
 * 账号身份徽章：与游戏状态徽章分开一层中性描边，不占用 success / warning 等状态语义。
 * 文字始终保留，不单靠颜色表达；空列表不渲染任何占位。
 */
export function BadgeList({ badges }: { badges: readonly BadgeKind[] }) {
  if (!badges.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {badges.map((kind) => (
        <span
          key={kind}
          className={cn(PLAYER_BADGE_BASE, "border border-border bg-background/60 text-muted-foreground")}
        >
          {BADGE_LABELS[kind]}
        </span>
      ))}
    </span>
  );
}

/**
 * 玩家行昵称旁的徽章：本人直接读账号资料，其他玩家按用户 ID 走公开资料缓存。
 * 徽章不进房间快照；读取失败静默留空，不挡玩家行。
 */
export function PlayerBadges({ account }: { account: PlayerAccount }): ReactNode {
  const own = useAccountStore((state) => state.profile);
  const isSelf = own?.id === account.userId;
  // 异步结果连同用户 ID 一起存：本人或换人后旧结果自然失效，不必在 effect 里同步清 state。
  const [loaded, setLoaded] = useState<{ userId: string; badges: readonly BadgeKind[] } | null>(
    null
  );

  useEffect(() => {
    if (isSelf) return;
    let alive = true;
    loadPublicProfile(account.userId).then(
      (profile) => {
        if (alive) setLoaded({ userId: account.userId, badges: profile.badges });
      },
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [account.userId, isSelf]);

  const badges =
    own?.id === account.userId ? own.badges : loaded?.userId === account.userId ? loaded.badges : [];
  return <BadgeList badges={badges} />;
}
