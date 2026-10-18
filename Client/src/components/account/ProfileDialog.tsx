import { useEffect, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
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
import { Spinner } from "@/components/ui/Spinner";
import { PlayerAvatar } from "@/components/common/PlayerAvatar";
import {
  SettingSwitchRow,
  SettingsFields,
  SettingsSection,
} from "@/components/common/room/SettingFields";
import { api, apiErrorMessage } from "@/lib/Api";
import type { OriginPoint } from "@/lib/Motion";
import {
  addPasskey,
  listPasskeys,
  passkeyErrorMessage,
  passkeySupported,
  removePasskey,
  type PasskeyEntry,
} from "@/lib/Passkey";
import { invalidatePublicProfile } from "@/lib/ProfileCache";
import { formatAbsoluteTime } from "@/lib/Time";
import { useAccountStore } from "@/stores/UseAccountStore";

/**
 * 账号资料：账号昵称只读展示（强制取自 QQ 昵称，不可修改）、QQ 号公开开关与通行密钥管理。
 * 头像随 QQ 自动同步，不可在站内修改；通行密钥在这里增删，登录入口在登录弹窗（端点面见 Agents/Account.md §2）。
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

type ListState =
  | { status: "loading" }
  | { status: "ready"; items: PasskeyEntry[] }
  | { status: "error"; message: string };

/**
 * 通行密钥管理：列、加、删。只在支持 WebAuthn 的浏览器出现——不支持时这里做不了任何事，
 * 摆一个必然失败的按钮只会让人以为账号坏了。
 *
 * 添加要求「新鲜」登录（服务端默认 24 小时内）：这是防会话被盗用后被人塞一把密钥的门槛，
 * 超时的错误码在这里翻成中文，不做静默重登。
 */
function PasskeySection() {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [busy, setBusy] = useState<"add" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 增删之后重取列表：库里的密钥以服务端为准，本地拼差一条就多一条不存在的密钥。 */
  const reload = async () => {
    try {
      setState({ status: "ready", items: await listPasskeys() });
    } catch (cause) {
      setState({ status: "error", message: passkeyErrorMessage(cause, "通行密钥读取失败") });
    }
  };

  useEffect(() => {
    let cancelled = false;
    void listPasskeys()
      .then((items) => !cancelled && setState({ status: "ready", items }))
      .catch((cause) =>
        !cancelled
          ? setState({ status: "error", message: passkeyErrorMessage(cause, "通行密钥读取失败") })
          : undefined
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const add = async () => {
    setBusy("add");
    setError(null);
    try {
      await addPasskey();
      await reload();
    } catch (cause) {
      setError(passkeyErrorMessage(cause, "通行密钥添加失败，请稍后重试"));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy("remove");
    setError(null);
    try {
      await removePasskey(id);
      await reload();
    } catch (cause) {
      setError(passkeyErrorMessage(cause, "通行密钥移除失败，请稍后重试"));
    } finally {
      setBusy(null);
    }
  };

  const items = state.status === "ready" ? state.items : [];

  return (
    <SettingsSection title="通行密钥" icon={KeyRound}>
      {state.status === "loading" ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner />
          正在读取通行密钥
        </div>
      ) : state.status === "error" ? (
        <p className="text-xs text-destructive">{state.message}</p>
      ) : (
        <ul className="grid gap-2">
          {items.length === 0 ? (
            <li className="text-xs text-muted-foreground">还没有添加通行密钥。</li>
          ) : null}
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            >
              <div className="min-w-0 text-sm">
                <div className="truncate">{item.name || "未命名通行密钥"}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {formatAbsoluteTime(item.createdAt)} 添加
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                disabled={busy !== null}
                onClick={() => void remove(item.id)}
              >
                移除
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy !== null || state.status === "loading"}
        loading={busy === "add"}
        onClick={() => void add()}
      >
        添加通行密钥
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
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
        {supportsPasskey ? <PasskeySection /> : null}
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
