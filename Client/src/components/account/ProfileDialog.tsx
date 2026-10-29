import { useEffect, useState, type FormEvent } from "react";
import { Award, KeyRound, Pencil } from "lucide-react";
import {
  badgeDescriptionOf,
  type AccountBadge,
  type AccountProfile,
  type BadgeKind,
} from "@bakagame/shared";
import { BadgeChip } from "@/components/common/BadgeList";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
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
  PASSKEY_NAME_MAX,
  addPasskey,
  listPasskeys,
  passkeyErrorMessage,
  passkeyRegistrationErrorMessage,
  passkeySupported,
  platformAuthenticatorAvailable,
  removePasskey,
  renamePasskey,
  type PasskeyAttachment,
  type PasskeyEntry,
} from "@/lib/Passkey";
import { invalidatePublicProfile } from "@/lib/ProfileCache";
import { formatAbsoluteTime } from "@/lib/Time";
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

type ListState =
  | { status: "loading" }
  | { status: "ready"; items: PasskeyEntry[] }
  | { status: "error"; message: string };

/**
 * 通行密钥管理：列、加、改名、删。只在支持 WebAuthn 的浏览器出现——不支持时这里做不了任何事，
 * 摆一个必然失败的按钮只会让人以为账号坏了。
 *
 * 添加拆成两条显式入口：`platform` 只调系统验证器，`cross-platform` 只调密码管理器与安全密钥。
 * 不分时 Windows 会默认弹 Hello，想用 Bitwarden 的人根本走不到跨设备那条路。
 *
 * 添加要求「新鲜」登录（服务端默认 24 小时内）：这是防会话被盗用后被人塞一把密钥的门槛，
 * 超时的错误码在这里翻成中文，不做静默重登。名字由 `lib/Passkey.ts` 按设备自动取，
 * 这里只给改名：一行就地换成输入框，回车或失焦提交、Esc 放弃，行高不变。
 */
function PasskeySection() {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [busy, setBusy] = useState<
    "add-platform" | "add-cross-platform" | "remove" | "rename" | null
  >(null);
  const [platformAuthenticator, setPlatformAuthenticator] = useState<boolean | undefined>(
    undefined
  );
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

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

  /** 只在明确为 false 时禁用「本机解锁」；浏览器不给答案（undefined）时不能替玩家下结论。 */
  useEffect(() => {
    let cancelled = false;
    void platformAuthenticatorAvailable().then(
      (available) => !cancelled && setPlatformAuthenticator(available)
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const add = async (attachment: PasskeyAttachment) => {
    setBusy(attachment === "platform" ? "add-platform" : "add-cross-platform");
    setError(null);
    try {
      await addPasskey(attachment);
      await reload();
    } catch (cause) {
      setError(
        passkeyRegistrationErrorMessage(
          cause,
          attachment,
          platformAuthenticator,
          "通行密钥添加失败，请稍后重试"
        )
      );
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

  /** 起编辑时把现名放进草稿；改名只动名字，凭据与登录行为不变，所以不必二次确认。 */
  const startRename = (item: PasskeyEntry) => {
    setEditingId(item.id);
    setDraft(item.name ?? "");
  };

  /**
   * Esc 只放弃这次改名，不顺手关掉整个弹窗。Radix 的关闭监听挂在 `document` 的捕获阶段，
   * React 的 `onKeyDown` 在它之后才跑，拦不住；要拦就得挂在更外层并截断传播。
   */
  useEffect(() => {
    if (editingId === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setEditingId(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [editingId]);

  /** 提交口径：空名与没改动的名都不发请求，直接收起输入框回到原名。 */
  const commitRename = async (item: PasskeyEntry) => {
    if (editingId !== item.id || busy !== null) return;
    const name = draft.trim();
    if (!name || name === (item.name ?? "")) {
      setEditingId(null);
      return;
    }
    setBusy("rename");
    setError(null);
    try {
      await renamePasskey(item.id, name);
      setEditingId(null);
      await reload();
    } catch (cause) {
      setEditingId(null);
      setError(passkeyErrorMessage(cause, "通行密钥改名失败，请稍后重试"));
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
          {items.map((item) => {
            const label = item.name || "未命名通行密钥";
            const editing = editingId === item.id;
            return (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                {/* 名字与输入框同占一行 24 px：就地切换不撑高这一行 */}
                <div className="min-w-0 flex-1 text-sm">
                  {editing ? (
                    <Input
                      autoFocus
                      value={draft}
                      aria-label="通行密钥名称"
                      maxLength={PASSKEY_NAME_MAX}
                      className="h-6 px-2"
                      onChange={(event) => setDraft(event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      onBlur={() => void commitRename(item)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          void commitRename(item);
                        }
                      }}
                    />
                  ) : (
                    <div className="leading-6 truncate">{label}</div>
                  )}
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {formatAbsoluteTime(item.createdAt)} 添加
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {editing ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label={`重命名「${label}」`}
                      disabled={busy !== null}
                      loading={busy === "rename"}
                      onClick={() => startRename(item)}
                    >
                      <Pencil />
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void remove(item.id)}
                  >
                    移除
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="grid gap-2">
        <p className="text-xs text-muted-foreground">
          本机解锁使用这台设备的指纹、面容或 Windows Hello；密码管理器或安全密钥可用于其它设备。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              busy !== null || state.status === "loading" || platformAuthenticator === false
            }
            loading={busy === "add-platform"}
            onClick={() => void add("platform")}
          >
            用本机解锁
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy !== null || state.status === "loading"}
            loading={busy === "add-cross-platform"}
            onClick={() => void add("cross-platform")}
          >
            用密码管理器或安全密钥
          </Button>
        </div>
        {platformAuthenticator === false ? (
          <p className="text-xs text-muted-foreground">本设备未检测到系统验证器。</p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsSection>
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
        <ul className="grid gap-2">{profile.badges.map(row)}</ul>
      ) : (
        <p className="text-xs text-muted-foreground">还没有获得徽章。</p>
      )}
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
        <BadgeSection profile={profile} />
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
