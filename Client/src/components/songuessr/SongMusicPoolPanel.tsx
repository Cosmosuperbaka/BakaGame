import { Fragment, useState } from "react";
import { Database } from "lucide-react";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import { Hint } from "@/components/ui/Tooltip";
import { cn } from "@/lib/Utils";
import { NeteaseCloudMusicIcon, QQMusicIcon } from "@/components/common/MusicPlatformIcons";
import { vipBadge, vipText } from "./SongAccountBadges";
import { AccountAvatar, VipBadgeMark } from "./SongAccountIdentity";
import type { SonGuessrMusicPoolView, SonGuessrRoomSnapshot } from "@bakagame/shared";

const PLATFORMS = [
  { platform: "qq", label: "QQ音乐", Icon: QQMusicIcon },
  { platform: "netease", label: "网易云音乐", Icon: NeteaseCloudMusicIcon },
] as const;

type PoolPlatform = (typeof PLATFORMS)[number]["platform"];

/** 一个号只露身份：头像、昵称、官方会员徽章；共享状态与取号统计不在这里展开。 */
function PoolAccount({ entry }: { entry: SonGuessrMusicPoolView }) {
  // 池里的归属平台是权威值：老账号对象缺 `platform` 时，徽章与档位文案仍按所在分组取。
  const account = { ...entry.account, platform: entry.platform };
  const badge = vipBadge(account);
  return (
    <li className="flex min-w-0 items-center gap-2.5">
      <AccountAvatar account={account} className="size-8" />
      <Hint label={account.nickname}>
        <span className="min-w-0 truncate text-sm font-medium">{account.nickname}</span>
      </Hint>
      {badge ? (
        <VipBadgeMark badge={badge} />
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">{vipText(account).label}</span>
      )}
    </li>
  );
}

function PlatformGroup({
  platform,
  label,
  Icon,
  entries,
}: {
  platform: PoolPlatform;
  label: string;
  Icon: typeof QQMusicIcon;
  entries: SonGuessrMusicPoolView[];
}) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        {label}
      </h3>
      <ul className="space-y-2.5">
        {entries.map((entry) => (
          <PoolAccount key={`${entry.playerId}:${platform}`} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

/**
 * 房主视角的账号池：哪个平台有几个号、每个号是谁。
 *
 * 只显示快照里那份脱敏视图（`SonGuessrMusicPoolView`），cookie 不进前端也不进快照。
 * 池里一个号都没有时不渲染：没有号的时候，界面该说的是「去登录一个」，不是摆一张空表。
 */
export function SongMusicPoolPanel({ snapshot }: { snapshot: SonGuessrRoomSnapshot }) {
  const [open, setOpen] = useState(false);
  const entries = snapshot.musicPool ?? [];
  if (entries.length === 0) return null;
  const groups = PLATFORMS.map((platform) => ({
    ...platform,
    entries: entries.filter((entry) => entry.platform === platform.platform),
  }));
  const headline = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      {groups.map(({ platform, label, Icon, entries: platformEntries }, index) => (
        <Fragment key={platform}>
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          <span className="inline-flex items-center gap-1">
            <Icon className={cn("shrink-0", platform === "qq" ? "size-4" : "size-3.5")} />
            <span className="sr-only">{label}</span>
            <span className="tabular-nums">{platformEntries.length} 个账号</span>
          </span>
        </Fragment>
      ))}
    </span>
  );
  return (
    <SettingsAccordion
      icon={Database}
      title="账号池"
      headline={headline}
      open={open}
      onOpenChange={setOpen}
    >
      <div className="space-y-4">
        {groups.map(({ platform, label, Icon, entries: platformEntries }) =>
          platformEntries.length > 0 ? (
            <PlatformGroup
              key={platform}
              platform={platform}
              label={label}
              Icon={Icon}
              entries={platformEntries}
            />
          ) : null
        )}
      </div>
    </SettingsAccordion>
  );
}
