import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Label } from "@/components/ui/Label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/Dialog";
import type { OriginPoint } from "@/lib/Motion";

/**
 * 房间类型开关（CCB 的「兼容原版」）：开启后房间建在另一种服务器上，下面的私密、旁观与名称上限随之切换含义。
 * 说明常驻，写明开启后的差别；不可用时开关禁用，说明换成原因。
 */
export interface RoomModeSwitch {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabledReason?: string;
}

export type RoomPrivacy = "password" | "unlisted";

/** 私密开关的标签与说明随含义变化；不在大厅显示的说明常驻，告诉房主链接仍然有效。 */
const PRIVACY_COPY: Record<RoomPrivacy, { label: string; description?: string }> = {
  password: { label: "私密房间" },
  unlisted: { label: "不在大厅显示", description: "开启后不在大厅列出，凭链接仍可进入。" },
};

export interface CreateRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  /** 房间名称上限，按当前服务器的协议传入；默认名称超出时截到上限，避免服务端拒绝。 */
  nameMaxLength?: number;
  /** 触发按钮位置，弹窗由此展开 */
  origin?: OriginPoint | null;
  /** 有另一种房间可建时显示的开关，放在房间名称之前：它决定下面各项的含义。 */
  roomMode?: RoomModeSwitch;
  /**
   * 私密的含义：`password`（默认）为私密房设密码、带锁进大厅；
   * `unlisted` 用于没有密码机制的服务器，开关只控制不进大厅，凭链接仍可进入。
   */
  privacy?: RoomPrivacy;
  /** 当前服务器不支持禁止观战时给出原因：开关禁用并常驻显示原因。 */
  spectatorsDisabledReason?: string;
  onCreate: (params: {
    name: string;
    visibility: "public" | "private";
    password?: string;
    allowSpectators: boolean;
  }) => Promise<void>;
  onValidationError?: (message: string) => void;
}

export function CreateRoomDialog({
  open,
  onOpenChange,
  defaultName,
  nameMaxLength,
  origin,
  roomMode,
  privacy,
  spectatorsDisabledReason,
  onCreate,
  onValidationError,
}: CreateRoomDialogProps) {
  // 表单随弹窗挂载/卸载，状态由初始值直接建立，无需打开后再同步。
  return (
    <Dialog open={open} onOpenChange={onOpenChange} origin={origin}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建房间</DialogTitle>
        </DialogHeader>
        <CreateRoomForm
          defaultName={defaultName}
          nameMaxLength={nameMaxLength}
          onOpenChange={onOpenChange}
          roomMode={roomMode}
          privacy={privacy}
          spectatorsDisabledReason={spectatorsDisabledReason}
          onCreate={onCreate}
          onValidationError={onValidationError}
        />
      </DialogContent>
    </Dialog>
  );
}

type CreateRoomFormProps = Pick<
  CreateRoomDialogProps,
  | "defaultName" | "nameMaxLength" | "onOpenChange" | "roomMode"
  | "privacy" | "spectatorsDisabledReason" | "onCreate" | "onValidationError"
>;

function CreateRoomForm({
  defaultName,
  nameMaxLength,
  onOpenChange,
  roomMode,
  privacy = "password",
  spectatorsDisabledReason,
  onCreate,
  onValidationError,
}: CreateRoomFormProps) {
  // 默认名称由用户名拼成，可能超过上限；切换服务器后上限也可能变小，提交时再按当前上限截一次。
  const [roomName, setRoomName] = useState(() => defaultName.slice(0, nameMaxLength));
  // 开关状态记下它属于哪种含义：切换服务器后两种「私密」不是一回事，开关回到关闭，不沿用上一种的选择。
  const [privateChoice, setPrivateChoice] = useState<{ privacy: RoomPrivacy; on: boolean }>({ privacy, on: false });
  const isPrivate = privateChoice.privacy === privacy && privateChoice.on;
  const needsPassword = isPrivate && privacy === "password";
  const privacyCopy = PRIVACY_COPY[privacy];
  const [password, setPassword] = useState("");
  const [allowSpectators, setAllowSpectators] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 标签与控件显式关联，读屏能读出每个开关与输入的名称。
  const nameFieldId = useId();
  const passwordFieldId = useId();
  const spectatorsLocked = Boolean(spectatorsDisabledReason);
  const errorId = useId();
  // 只有「私密房缺密码」落在具体输入框上；服务端返回的失败不标红任何字段。
  const passwordInvalid = needsPassword && !password.trim() && errorMessage !== null;

  const handleCreate = async () => {
    if (needsPassword && !password.trim()) {
      const msg = "私密房间需要设置密码";
      setErrorMessage(msg);
      onValidationError?.(msg);
      return;
    }
    setErrorMessage(null);
    setLoading(true);
    try {
      await onCreate({
        name: (roomName || "新房间").slice(0, nameMaxLength),
        visibility: isPrivate ? "private" : "public",
        password: needsPassword ? password : undefined,
        allowSpectators: spectatorsLocked || allowSpectators,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "创建房间失败";
      setErrorMessage(msg);
      onValidationError?.(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="space-y-5">
        {roomMode ? (
          <SwitchField
            label={roomMode.label}
            description={roomMode.disabledReason ?? roomMode.description}
            checked={roomMode.checked}
            onCheckedChange={roomMode.onCheckedChange}
            disabled={Boolean(roomMode.disabledReason)}
          />
        ) : null}
        <div className="space-y-2">
          <Label htmlFor={nameFieldId} className="text-sm">房间名称</Label>
          <Input
            id={nameFieldId}
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            maxLength={nameMaxLength}
            placeholder="输入房间名称"
            // 打开弹窗时焦点落在名称上：房间类型开关排在它前面，默认的「首个可聚焦元素」会落到开关上。
            autoFocus
            className="h-10"
          />
        </div>
        <SwitchField
          label={privacyCopy.label}
          description={privacyCopy.description}
          checked={isPrivate}
          onCheckedChange={(on) => setPrivateChoice({ privacy, on })}
        />
        <CollapsibleRegion open={needsPassword}>
              <div className="space-y-2 pb-1">
                <Label htmlFor={passwordFieldId} className="text-sm">房间密码</Label>
                <Input
                  id={passwordFieldId}
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  placeholder="设置房间密码"
                  aria-invalid={passwordInvalid || undefined}
                  aria-describedby={passwordInvalid ? errorId : undefined}
                  className="h-10"
                />
              </div>
        </CollapsibleRegion>
        {/* 不允许禁止观战的服务器上开关恒为开：显示与实际提交一致，不沿用另一服务器上关掉的状态。 */}
        <SwitchField
          label="允许旁观"
          description={spectatorsDisabledReason}
          checked={spectatorsLocked || allowSpectators}
          onCheckedChange={setAllowSpectators}
          disabled={spectatorsLocked}
        />
        {errorMessage && (
          <p id={errorId} role="alert" className="text-xs text-destructive">{errorMessage}</p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button onClick={handleCreate} disabled={loading}>
          {loading ? "创建中..." : "创建"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** 弹窗里的开关行：标签与开关同一行，说明常驻在下方并经 `aria-describedby` 关联。 */
function SwitchField({ label, description, checked, onCheckedChange, disabled = false }: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const descriptionId = useId();
  return (
    <div className="space-y-1 py-1">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className={disabled ? "text-sm opacity-50" : "text-sm"}>{label}</Label>
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          aria-describedby={description ? descriptionId : undefined}
        />
      </div>
      {description ? <p id={descriptionId} className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}
