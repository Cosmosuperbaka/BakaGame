import { useState } from "react";
import { EyeOff, Globe, Lock, Users, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/Dialog";
import { SettingSwitchRow, SettingTextField } from "@/components/common/room/SettingFields";
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
  /** 开关行图标，与下面私密、旁观两行对齐 */
  icon?: LucideIcon;
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
  /**
   * @deprecated 校验与建房失败都写在弹窗里（缺密码标在密码框上，服务端失败写在表单末尾），不再回调；保留只为兼容旧调用。
   */
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
}: CreateRoomDialogProps) {
  // 表单随弹窗挂载/卸载，状态由初始值直接建立，无需打开后再同步。
  return (
    <Dialog open={open} onOpenChange={onOpenChange} origin={origin}>
      {/* 标题已说清任务，表单字段各有标签与说明，不另写一段描述；显式置空，Radix 不再提示缺少描述。 */}
      <DialogContent aria-describedby={undefined}>
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
        />
      </DialogContent>
    </Dialog>
  );
}

type CreateRoomFormProps = Pick<
  CreateRoomDialogProps,
  | "defaultName" | "nameMaxLength" | "onOpenChange" | "roomMode"
  | "privacy" | "spectatorsDisabledReason" | "onCreate"
>;

function CreateRoomForm({
  defaultName,
  nameMaxLength,
  onOpenChange,
  roomMode,
  privacy = "password",
  spectatorsDisabledReason,
  onCreate,
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
  // 两类失败分开放：缺密码落在密码框上（标红并关联文案）；服务端返回的失败归不到字段，只在表单末尾给一行文案。
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const spectatorsLocked = Boolean(spectatorsDisabledReason);

  const handleCreate = async () => {
    if (loading) return;
    if (needsPassword && !password.trim()) {
      setPasswordError("私密房间需要设置密码");
      return;
    }
    setPasswordError(null);
    setServerError(null);
    setLoading(true);
    try {
      await onCreate({
        name: (roomName || "新房间").slice(0, nameMaxLength),
        visibility: isPrivate ? "private" : "public",
        password: needsPassword ? password : undefined,
        allowSpectators: spectatorsLocked || allowSpectators,
      });
    } catch (err: unknown) {
      // 只走这一种渠道：失败写在弹窗里，不再同时弹 Toast。
      setServerError((err as { message?: string } | null)?.message || "创建房间失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    // 整张表单一次提交：回车即创建，提交中按钮转圈并禁用，不再手写「创建中」。
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void handleCreate();
      }}
    >
      <div className="space-y-5">
        {roomMode ? (
          <SettingSwitchRow
            label={roomMode.label}
            icon={roomMode.icon}
            description={roomMode.disabledReason ?? roomMode.description}
            checked={roomMode.checked}
            onCheckedChange={roomMode.onCheckedChange}
            disabled={Boolean(roomMode.disabledReason)}
          />
        ) : null}
        <SettingTextField
          label="房间名称"
          value={roomName}
          onChange={setRoomName}
          maxLength={nameMaxLength}
          placeholder="输入房间名称"
          // 打开弹窗时焦点落在名称上：房间类型开关排在它前面，默认的「首个可聚焦元素」会落到开关上。
          autoFocus
          inputClassName="h-10"
        />
        <SettingSwitchRow
          label={privacyCopy.label}
          // 原版房的「不在大厅显示」没有密码，开启时不用锁（Design §6）。
          icon={isPrivate ? (privacy === "unlisted" ? EyeOff : Lock) : Globe}
          description={privacyCopy.description}
          checked={isPrivate}
          onCheckedChange={(on) => setPrivateChoice({ privacy, on })}
        />
        <CollapsibleRegion open={needsPassword}>
          <div className="pb-1">
            <SettingTextField
              label="房间密码"
              type="password"
              value={password}
              onChange={(value) => {
                setPassword(value);
                if (passwordError) setPasswordError(null);
              }}
              placeholder="设置房间密码"
              error={passwordError}
              inputClassName="h-10"
            />
          </div>
        </CollapsibleRegion>
        {/* 不允许禁止观战的服务器上开关恒为开：显示与实际提交一致，不沿用另一服务器上关掉的状态。 */}
        <SettingSwitchRow
          label="允许旁观"
          icon={Users}
          description={spectatorsDisabledReason}
          checked={spectatorsLocked || allowSpectators}
          onCheckedChange={setAllowSpectators}
          disabled={spectatorsLocked}
        />
        {serverError ? <p role="alert" className="text-xs text-destructive">{serverError}</p> : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button type="submit" loading={loading}>
          创建
        </Button>
      </DialogFooter>
    </form>
  );
}
