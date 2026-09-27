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
  /** 当前服务器不支持私密房时给出原因：开关禁用并常驻显示原因。 */
  privateRoomDisabledReason?: string;
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
  privateRoomDisabledReason,
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
          privateRoomDisabledReason={privateRoomDisabledReason}
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
  | "privateRoomDisabledReason" | "spectatorsDisabledReason" | "onCreate" | "onValidationError"
>;

function CreateRoomForm({
  defaultName,
  onOpenChange,
  serverOptions,
  server,
  onServerChange,
  privateRoomDisabledReason,
  spectatorsDisabledReason,
  onCreate,
  onValidationError,
}: CreateRoomFormProps) {
  const [roomName, setRoomName] = useState(defaultName);
  const [isPrivate, setIsPrivate] = useState(false);
  const [password, setPassword] = useState("");
  const [allowSpectators, setAllowSpectators] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 标签与控件显式关联，读屏能读出每个开关与输入的名称。
  const nameFieldId = useId();
  const privateFieldId = useId();
  const passwordFieldId = useId();
  const spectatorsFieldId = useId();

  const handleCreate = async () => {
    if (isPrivate && !password.trim()) {
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
        password: isPrivate ? password : undefined,
        allowSpectators,
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
            <Label htmlFor={privateFieldId} className="text-sm">私密房间</Label>
            <Switch id={privateFieldId} checked={isPrivate} onCheckedChange={setIsPrivate} disabled={Boolean(privateRoomDisabledReason)} />
          </div>
          {privateRoomDisabledReason ? <p className="text-xs text-muted-foreground">{privateRoomDisabledReason}</p> : null}
        </div>
        <AnimatePresence initial={false}>
          {isPrivate && (
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
                  className="h-10"
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="space-y-1 py-1">
          <div className="flex items-center justify-between">
            <Label htmlFor={spectatorsFieldId} className="text-sm">允许旁观</Label>
            <Switch id={spectatorsFieldId} checked={allowSpectators} onCheckedChange={setAllowSpectators} disabled={Boolean(spectatorsDisabledReason)} />
          </div>
          {spectatorsDisabledReason ? <p className="text-xs text-muted-foreground">{spectatorsDisabledReason}</p> : null}
        </div>
        {errorMessage && (
          <p role="alert" className="text-xs text-destructive">{errorMessage}</p>
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
