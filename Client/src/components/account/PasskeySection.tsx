import { useEffect, useState } from "react";
import { KeyRound, Pencil } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FormAlert } from "./FormAlert";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { SettingsSection } from "@/components/common/room/settings/Layout";
import { PASSKEY_NAME_MAX, type PasskeyEntry } from "@/lib/Passkey";
import { formatAbsoluteTime } from "@/lib/Time";
import { usePasskeys } from "./UsePasskeys";

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
export function PasskeySection() {
  const { state, busy, error, platformAuthenticator, add, remove, rename } = usePasskeys();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

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
    await rename(item.id, name, () => setEditingId(null));
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
        <FormAlert>{state.message}</FormAlert>
      ) : (
        <ul className="grid grid-cols-1 gap-2">
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
                  {/* 时间与「添加」不拆行：窄屏宁可截断，也不把「添加」两字甩到第二行。 */}
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
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
                      {busy === "rename" ? null : <Pencil />}
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
      {error ? <FormAlert>{error}</FormAlert> : null}
    </SettingsSection>
  );
}
