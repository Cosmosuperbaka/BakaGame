import { useState, type FormEvent } from "react";
import { ORPCError } from "@orpc/client";
import { Award } from "lucide-react";
import {
  ACCOUNT_NAME_MAX_LENGTH,
  badgeDescriptionOf,
  normalizeAccountName,
} from "@bakagame/shared/values";
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
import { SettingTextField } from "@/components/common/room/settings/TextFields";
import {
  ACCOUNT_NAME_COOLDOWN_DAYS,
  formatNameChangeTime,
  formatNameCooldownLeft,
  nameChangeAvailableAt,
} from "@/lib/AccountName";
import { api, apiErrorMessage } from "@/lib/Api";
import type { OriginPoint } from "@/lib/motion/Origin";
import { passkeySupported } from "@/lib/Passkey";
import { PasskeySection } from "./PasskeySection";
import { invalidatePublicProfile } from "@/lib/ProfileCache";
import { useAccountStore } from "@/stores/UseAccountStore";
import { serverNow } from "@/stores/UseServerClock";

/** 这些业务错误说的是昵称本身，落在昵称字段下方；其余失败归表单整体（见 DesignGuide §6）。 */
const NAME_ERROR_CODES = new Set([
  "ACCOUNT_NAME_REQUIRED",
  "TEXT_SENSITIVE",
  "NAME_CHANGE_COOLDOWN",
]);

/**
 * 账号资料：账号昵称（玩家自填，可改名但有冷却，见 Server/docs/Account.md §1）、QQ 号公开开关与通行密钥管理。
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

/**
 * 昵称字段的说明：可改时说明冷却规则，冷却中给出下次可改的时刻与剩余时间。
 * 冷却按打开弹窗时的时刻判定一次：弹窗是短暂的，不为跨过冷却终点而逐秒重渲染。
 */
function useNameCooldown(nameChangedAt: string | null) {
  const [now] = useState(serverNow);
  const availableAt = nameChangeAvailableAt(nameChangedAt);
  const locked = availableAt !== null && now < availableAt;
  return {
    locked,
    description: locked
      ? `${formatNameChangeTime(availableAt)} 后可再次修改，还剩 ${formatNameCooldownLeft(availableAt - now)}`
      : `其他玩家在资料卡上看到的名字，每 ${ACCOUNT_NAME_COOLDOWN_DAYS} 天可修改一次`,
  };
}

/** 每次打开以当前资料为草稿起点。 */
function ProfileDialogBody({ profile, onDone }: { profile: AccountProfile; onDone: () => void }) {
  const setProfile = useAccountStore((state) => state.setProfile);
  const [supportsPasskey] = useState(passkeySupported);
  const [name, setName] = useState(profile.name);
  const [showQq, setShowQq] = useState(profile.showQq);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cooldown = useNameCooldown(profile.nameChangedAt);
  // 与服务端同一口径清洗后再比：只多敲了空格不算改名，也就不会白白消耗冷却。
  const nextName = normalizeAccountName(name);
  const nameDirty = name !== profile.name && nextName !== profile.name;
  const dirty = nameDirty || showQq !== profile.showQq;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || busy) return;
    if (nameDirty && !nextName) {
      setNameError("请填写账号昵称");
      return;
    }
    setBusy(true);
    setError(null);
    setNameError(null);
    try {
      const next = await api.account.updateProfile({
        showQq,
        ...(nameDirty ? { name: nextName } : {}),
      });
      setProfile(next);
      invalidatePublicProfile(next.id);
      onDone();
    } catch (cause) {
      const message = apiErrorMessage(cause, "保存失败，请稍后重试");
      if (cause instanceof ORPCError && NAME_ERROR_CODES.has(cause.code)) setNameError(message);
      else setError(message);
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
            账号昵称显示在资料卡与排位中。游戏内昵称在各游戏里单独填写，与账号昵称无关。
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
          <SettingTextField
            label="账号昵称"
            value={name}
            onChange={(value) => {
              setName(value);
              setNameError(null);
            }}
            placeholder="给自己取个名字"
            maxLength={ACCOUNT_NAME_MAX_LENGTH}
            description={cooldown.description}
            disabled={cooldown.locked}
            error={nameError}
          />
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
