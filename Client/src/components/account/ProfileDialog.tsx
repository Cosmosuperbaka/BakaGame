import { useState, type FormEvent } from "react";
import type { AccountProfile } from "@/types";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { PlayerAvatar } from "@/components/common/PlayerAvatar";
import { SettingSwitchRow, SettingsFields } from "@/components/common/room/SettingFields";
import { api, apiErrorMessage } from "@/lib/Api";
import type { OriginPoint } from "@/lib/Motion";
import { invalidatePublicProfile } from "@/lib/ProfileCache";
import { useAccountStore } from "@/stores/UseAccountStore";

/**
 * 账号资料：账号昵称只读展示（强制取自 QQ 昵称，不可修改）与 QQ 号公开开关。
 * 头像随 QQ 自动同步，不可在站内修改。
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

/** 每次打开以当前资料为草稿起点。 */
function ProfileDialogBody({ profile, onDone }: { profile: AccountProfile; onDone: () => void }) {
  const setProfile = useAccountStore((state) => state.setProfile);
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
      <form onSubmit={(event) => void submit(event)} className="grid gap-4">
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
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
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
