import { useId, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Label } from "@/components/ui/Label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/Dialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { collapsible } from "@/lib/Motion";
import type { OriginPoint } from "@/lib/Motion";

export interface ServerOption {
  value: string;
  label: string;
  /** 不可用原因；给出时该分段禁用并显示原因。 */
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
  /** 触发按钮位置，弹窗由此展开 */
  origin?: OriginPoint | null;
  /** 有多个服务器可选时显示分段；选项可带禁用原因。 */
  serverOptions?: ServerOption[];
  server?: string;
  onServerChange?: (server: string) => void;
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
  origin,
  serverOptions,
  server,
  onServerChange,
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
          onOpenChange={onOpenChange}
          serverOptions={serverOptions}
          server={server}
          onServerChange={onServerChange}
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
  | "defaultName" | "onOpenChange" | "serverOptions" | "server" | "onServerChange"
  | "privacy" | "spectatorsDisabledReason" | "onCreate" | "onValidationError"
>;

function CreateRoomForm({
  defaultName,
  onOpenChange,
  serverOptions,
  server,
  onServerChange,
  privacy = "password",
  spectatorsDisabledReason,
  onCreate,
  onValidationError,
}: CreateRoomFormProps) {
  const [roomName, setRoomName] = useState(defaultName);
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
  const privateFieldId = useId();
  const privateDescriptionId = useId();
  const passwordFieldId = useId();
  const spectatorsFieldId = useId();
  const spectatorsDescriptionId = useId();
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
        name: roomName || "新房间",
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
        {serverOptions?.length ? (
          <div className="space-y-2">
            <SegmentedControl
              aria-label="房间服务器"
              value={server ?? serverOptions[0].value}
              options={serverOptions.map((option) => ({ value: option.value, label: option.label, disabled: Boolean(option.disabledReason) }))}
              onValueChange={(value) => onServerChange?.(value)}
            />
            {serverOptions.find((option) => option.disabledReason)?.disabledReason ? (
              // 禁用的分段点不动，原因必须常驻可见，玩家才知道为什么选不了。
              <p className="text-xs text-muted-foreground">{serverOptions.find((option) => option.disabledReason)?.disabledReason}</p>
            ) : null}
          </div>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor={nameFieldId} className="text-sm">房间名称</Label>
          <Input
            id={nameFieldId}
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            placeholder="输入房间名称"
            className="h-10"
          />
        </div>
        <div className="space-y-1 py-1">
          <div className="flex items-center justify-between">
            <Label htmlFor={privateFieldId} className="text-sm">{privacyCopy.label}</Label>
            <Switch
              id={privateFieldId}
              checked={isPrivate}
              onCheckedChange={(on) => setPrivateChoice({ privacy, on })}
              aria-describedby={privacyCopy.description ? privateDescriptionId : undefined}
            />
          </div>
          {privacyCopy.description ? (
            <p id={privateDescriptionId} className="text-xs text-muted-foreground">{privacyCopy.description}</p>
          ) : null}
        </div>
        <AnimatePresence initial={false}>
          {needsPassword && (
            <motion.div
              variants={collapsible}
              initial="initial"
              animate="animate"
              exit="exit"
              className="overflow-hidden"
            >
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
            </motion.div>
          )}
        </AnimatePresence>
        <div className="space-y-1 py-1">
          <div className="flex items-center justify-between">
            <Label htmlFor={spectatorsFieldId} className="text-sm">允许旁观</Label>
            {/* 不允许禁止观战的服务器上开关恒为开：显示与实际提交一致，不沿用另一服务器上关掉的状态。 */}
            <Switch
              id={spectatorsFieldId}
              checked={spectatorsLocked || allowSpectators}
              onCheckedChange={setAllowSpectators}
              disabled={spectatorsLocked}
              aria-describedby={spectatorsLocked ? spectatorsDescriptionId : undefined}
            />
          </div>
          {spectatorsLocked ? <p id={spectatorsDescriptionId} className="text-xs text-muted-foreground">{spectatorsDisabledReason}</p> : null}
        </div>
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
