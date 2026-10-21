import { useState } from "react";
import { Database } from "lucide-react";
import { SettingsAccordion } from "@/components/common/room/SettingsAccordion";
import { Hint } from "@/components/ui/Tooltip";
import { cn } from "@/lib/Utils";
import { NeteaseCloudMusicIcon, QQMusicIcon } from "./SongAccountSettings";
import type { SonGuessrMusicPoolView, SonGuessrRoomSnapshot } from "@bakagame/shared";

const PLATFORM_LABEL: Record<SonGuessrMusicPoolView["platform"], string> = {
  netease: "网易云",
  qq: "QQ音乐",
};

/** 会员档：只读服务端给的档位，缺档位时按「非会员」显示（与账号卡同一套口径）。 */
const tierLabel = (entry: SonGuessrMusicPoolView): string => {
  if (entry.account.vipStatus !== "vip") return "非会员";
  if (entry.account.vipTier === "svip") return "超级会员";
  if (entry.account.vipTier === "musicPackage") return "音乐包";
  return "会员";
};

const rateLabel = (entry: SonGuessrMusicPoolView): string =>
  entry.recentTotal === 0 ? "暂无记录" : `${entry.recentOk}/${entry.recentTotal}`;

/** 一行一个号：归属玩家、平台、会员档、在途数、近期成功率与最近失败原因。凭据本身不进快照，这里也读不到。 */
function PoolRow({ entry }: { entry: SonGuessrMusicPoolView }) {
  // 服务端只下发仍在生效的冷却（到点就自行恢复），所以有字段即冷却中，不必再比本机时钟。
  const cooling = entry.cooldownUntil !== undefined;
  const Icon = entry.platform === "qq" ? QQMusicIcon : NeteaseCloudMusicIcon;
  const status = cooling ? "冷却中" : entry.enabled ? "共享中" : "已关闭";
  return (
    <li className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={cn("shrink-0", entry.platform === "qq" ? "size-4" : "size-3.5")} />
        <Hint label={entry.playerName}>
          <span className="min-w-0 truncate text-sm font-medium">{entry.playerName}</span>
        </Hint>
        <span className="shrink-0 text-xs text-muted-foreground">
          {PLATFORM_LABEL[entry.platform]} · {tierLabel(entry)}
        </span>
        <span
          className={cn(
            "ml-auto shrink-0 text-xs",
            status === "共享中" ? "text-success" : "text-muted-foreground"
          )}
        >
          {status}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-[1.375rem] text-2xs text-muted-foreground">
        <span>在途 {entry.inFlight}</span>
        <span>近期成功 {rateLabel(entry)}</span>
        {entry.lastFailureReason ? (
          <Hint label={entry.lastFailureReason}>
            <span className="max-w-full truncate text-destructive">
              最近失败：{entry.lastFailureReason}
            </span>
          </Hint>
        ) : null}
      </div>
    </li>
  );
}

/**
 * 房主视角的账号池：谁贡献了号、现在能不能用、最近跑得顺不顺。
 *
 * 只显示快照里那份脱敏视图（`SonGuessrMusicPoolView`），cookie 不进前端也不进快照。
 * 池里一个号都没有时不渲染：没有号的时候，界面该说的是「去登录一个」，不是摆一张空表。
 */
export function SongMusicPoolPanel({ snapshot }: { snapshot: SonGuessrRoomSnapshot }) {
  const [open, setOpen] = useState(false);
  const entries = snapshot.musicPool ?? [];
  if (entries.length === 0) return null;
  const isCooling = (entry: SonGuessrMusicPoolView) => entry.cooldownUntil !== undefined;
  const ready = entries.filter((entry) => entry.enabled && !isCooling(entry)).length;
  return (
    <SettingsAccordion
      icon={Database}
      title="账号池"
      summary={[`${entries.length} 个账号`, `${ready} 个可用`, ...entries.map((e) => e.playerName)]}
      open={open}
      onOpenChange={setOpen}
    >
      <ul className="divide-y">
        {entries.map((entry) => (
          <PoolRow key={`${entry.playerId}:${entry.platform}`} entry={entry} />
        ))}
      </ul>
    </SettingsAccordion>
  );
}