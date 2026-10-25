import { UserRound } from "lucide-react";
import { cn } from "@/lib/Utils";
import type { SonGuessrMusicAccount } from "@bakagame/shared";
import type { VipBadge } from "./SongAccountBadges";

export function AccountAvatar({
  account,
  className,
}: {
  account: SonGuessrMusicAccount;
  className: string;
}) {
  return account.avatarUrl ? (
    <img
      src={account.avatarUrl}
      alt=""
      className={cn(className, "shrink-0 rounded-full bg-muted object-cover")}
    />
  ) : (
    <span
      className={cn(
        className,
        "flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
      )}
    >
      <UserRound className="size-3/5" aria-hidden="true" />
    </span>
  );
}

/** 官方会员徽章图：折叠账号行、展开卡与房主账号池共用。
 *  QQ 音乐官方母版 PNG 画布高 46px 但徽章实体仅占 28px（上下含 9px 透明边距），
 *  需将图像高放大约 1.64 倍至 26px 并配合 -my-[5px] 负外边距，使视觉实体高度与网易云（无透明边距 16px）绝对对齐且不撑高外层行高。 */
export function VipBadgeMark({ badge }: { badge: VipBadge }) {
  const isQq = badge.platform === "qq" || badge.src.includes("qqmusic-vip");
  return (
    <img
      src={badge.src}
      alt={badge.label}
      className={cn("w-auto shrink-0", isQq ? "h-[26px] -my-[5px]" : "h-4")}
    />
  );
}

/** 官方会员徽章（没有徽章的档位退回文字）与到期日：折叠单行与展开卡共用，保证两处的图片与排版一致。 */
export function VipStatus({
  vip,
  badge,
}: {
  vip: { label: string; expire: string };
  badge: VipBadge | null;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      {badge ? (
        <VipBadgeMark badge={badge} />
      ) : (
        <span className="font-medium text-foreground">{vip.label}</span>
      )}
      {vip.expire ? (
        <>
          {" "}
          <span className="tabular-nums">{vip.expire}</span>
        </>
      ) : null}
    </span>
  );
}
