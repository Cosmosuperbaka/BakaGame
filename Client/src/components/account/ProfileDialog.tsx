import { useState, type FormEvent } from "react";
import type { AccountProfile } from "@/types";
import { ACCOUNT_NAME_MAX_LENGTH, normalizeAccountName } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { PlayerAvatar } from "@/components/common/PlayerAvatar";
import { SettingSwitchRow, SettingTextField, SettingsFields } from "@/components/common/room/SettingFields";
import { api, apiErrorMessage } from "@/lib/Api";
import type { OriginPoint } from "@/lib/Motion";
import { invalidatePublicProfile } from "@/lib/ProfileCache";
import { useAccountStore } from "@/stores/UseAccountStore";

/**
 * 账号资料：账号昵称与 QQ 号公开开关。头像随 QQ 自动同步，不可在站内修改。
 * 账号昵称只显示在资料卡上，游戏内昵称仍在各游戏里单独填写。
 */
export function ProfileDialog({ open, onOpenChange, origin }: { open: boolean; onOpenChange: (open: boolean) => void; origin?: OriginPoint | null }) {
  const profile = useAccountStore((state) => state.profile);
  return (
    <Dialog open={open && Boolean(profile)} onOpenChange={onOpenChange} origin={origin}>
      {profile ? <ProfileDialogBody profile={profile} onDone={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

/** 每次打开以当前资料为草稿起点。 */
function ProfileDialogBody({ profile, onDone }: { profile: AccountProfile; onDone: () => void }) {
  const setProfile = useAccountStore((state) => state.setProfile);
  const [name, setName] = useState(profile.name);
  const [showQq, setShowQq] = useState(profile.showQq);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalized = normalizeAccountName(name);
  const dirty = normalized !== profile.name || showQq !== profile.showQq;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!normalized || !dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.account.updateProfile({
        ...(normalized !== profile.name ? { name: normalized } : {}),
        ...(showQq !== profile.showQq ? { showQq } : {}),
      });
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
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>账号资料</DialogTitle>
            <DialogDescription>头像随 QQ 自动同步。游戏内昵称在各游戏里单独填写，与账号昵称无关。</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3">
            <PlayerAvatar name={profile.name} image={profile.image} className="h-14 w-14 text-lg" />
            <div className="min-w-0 text-sm">
              <div className="truncate font-semibold">{profile.name}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">QQ <span className="font-mono">{profile.qqNumber}</span></div>
            </div>
          </div>
          <SettingsFields>
            <SettingTextField
              label="账号昵称"
              value={name}
              onChange={setName}
              placeholder="显示在资料卡上"
              maxLength={ACCOUNT_NAME_MAX_LENGTH}
              error={name && !normalized ? "请填写账号昵称" : null}
              inputClassName="h-10"
            />
            <SettingSwitchRow
              label="资料卡显示 QQ 号"
              description="关闭时其他玩家只能看到头像与昵称"
              checked={showQq}
              onCheckedChange={setShowQq}
            />
          </SettingsFields>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone}>取消</Button>
            <Button type="submit" disabled={!normalized || !dirty} loading={busy}>保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
  );
}
