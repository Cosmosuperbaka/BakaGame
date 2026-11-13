import { useState, type FormEvent } from "react";
import { Award } from "lucide-react";
import { badgeDescriptionOf } from "@bakagame/shared/values";
import type { AccountBadge, AccountProfile, BadgeKind } from "@bakagame/shared";
import { BadgeChip } from "@/components/common/BadgeList";
import { Button } from "@/components/ui/Button";
import { FormAlert } from "./FormAlert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { PlayerAvatar } from "@/components/common/PlayerAvatar";
import { SettingsFields, SettingsSection } from "@/components/common/room/settings/Layout";
import { SettingSwitchRow } from "@/components/common/room/settings/ChoiceFields";
import { api, apiErrorMessage } from "@/lib/Api";
import type { OriginPoint } from "@/lib/motion/Origin";
import { passkeySupported } from "@/lib/Passkey";
import { PasskeySection } from "./PasskeySection";
import { invalidatePublicProfile } from "@/lib/ProfileCache";
import { useAccountStore } from "@/stores/UseAccountStore";

/**
 * 账号资料：账号昵称只读展示（强制取自 QQ 昵称，不可修改）、QQ 号公开开关与通行密钥管理。
 * 头像随 QQ 自动同步，不可在站内修改；通行密钥在这里增删，登录入口在登录弹窗（端点面见 Server/docs/Account.md §2）。
 */
export function ProfileDialog({
  open,
  onOpenChange,
  origin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  origin?: OriginPoint | null;
}) {
  const profile = useAccountStore((state) => state.profile);
  return (
    <Dialog open={open && Boolean(profile)} onOpenChange={onOpenChange} origin={origin}>
      {profile ? <ProfileDialogBody profile={profile} onDone={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

/**
 * 佩戴徽章：点一枚立即生效，不走表单的保存按钮。
 * 已佩戴的那枚可取消；只有自己已获得的徽章才会出现在这里。
 */
function BadgeSection({ profile }: { profile: AccountProfile }) {
  const setProfile = useAccountStore((state) => state.setProfile);
  const [busy, setBusy] = useState<BadgeKind | "none" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const equip = async (badge: BadgeKind | null) => {
    setBusy(badge ?? "none");
    setError(null);
    try {
      const next = await api.account.equipBadge({ badge });
      setProfile(next);
      invalidatePublicProfile(next.id);
    } catch (cause) {
      setError(apiErrorMessage(cause, "佩戴徽章失败，请稍后重试"));
    } finally {
      setBusy(null);
    }
  };

  const row = (badge: AccountBadge) => {
    const equipped = profile.equippedBadge === badge.kind;
    return (
      <li
        key={badge.kind}
        className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <BadgeChip badge={badge} />
            {equipped ? <span className="text-xs text-muted-foreground">佩戴中</span> : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {badgeDescriptionOf(badge)}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy !== null}
          loading={busy === badge.kind || (equipped && busy === "none")}
          onClick={() => void equip(equipped ? null : badge.kind)}
        >
          {equipped ? "取消佩戴" : "佩戴"}
        </Button>
      </li>
    );
  };

  return (
    <SettingsSection title="身份徽章" icon={Award}>
      {profile.badges.length ? (
        <ul className="grid grid-cols-1 gap-2">{profile.badges.map(row)}</ul>
      ) : (
        <p className="text-xs text-muted-foreground">还没有获得徽章。</p>
      )}
      {error ? <FormAlert>{error}</FormAlert> : null}
    </SettingsSection>
  );
}

/** 每次打开以当前资料为草稿起点。 */
function ProfileDialogBody({ profile, onDone }: { profile: AccountProfile; onDone: () => void }) {
  const setProfile = useAccountStore((state) => state.setProfile);
  const [supportsPasskey] = useState(passkeySupported);
  const [showQq, setShowQq] = useState(profile.showQq);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = showQq !== profile.showQq;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.account.updateProfile({ showQq });
      setProfile(next);
      invalidatePublicProfile(next.id);
      onDone();
    } catch (cause) {
      setError(apiErrorMessage(cause, "保存失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent>
      {/* min-w-0：弹窗本体是 grid，表单作为网格项默认不小于内容最小宽度；
          通行密钥名一行不换行（截断），会把整张表单撑出弹窗右缘。 */}
      <form onSubmit={(event) => void submit(event)} className="grid min-w-0 grid-cols-1 gap-4">
        <DialogHeader>
          <DialogTitle>账号资料</DialogTitle>
          <DialogDescription>
            账号昵称取自你的 QQ 昵称，不可修改。游戏内昵称在各游戏里单独填写，与账号昵称无关。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3">
          <PlayerAvatar name={profile.name} image={profile.image} className="h-14 w-14 text-lg" />
          <div className="min-w-0 text-sm">
            <div className="truncate font-semibold">{profile.name}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              QQ <span className="font-mono">{profile.qqNumber}</span>
            </div>
          </div>
        </div>
        <SettingsFields>
          <SettingSwitchRow
            label="资料卡显示 QQ 号"
            description="关闭时其他玩家只能看到头像与昵称"
            checked={showQq}
            onCheckedChange={setShowQq}
          />
        </SettingsFields>
        <BadgeSection profile={profile} />
        {supportsPasskey ? <PasskeySection /> : null}
        {error ? <FormAlert>{error}</FormAlert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone}>
            取消
          </Button>
          <Button type="submit" disabled={!dirty} loading={busy}>
            保存
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
