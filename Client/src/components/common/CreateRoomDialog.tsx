import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Label } from "@/components/ui/Label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/Dialog";
import { collapsible } from "@/lib/Motion";
import type { OriginPoint } from "@/lib/Motion";

export interface CreateRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  /** 触发按钮位置，弹窗由此展开 */
  origin?: OriginPoint | null;
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
          onCreate={onCreate}
          onValidationError={onValidationError}
        />
      </DialogContent>
    </Dialog>
  );
}

type CreateRoomFormProps = Pick<
  CreateRoomDialogProps,
  "defaultName" | "onOpenChange" | "onCreate" | "onValidationError"
>;

function CreateRoomForm({
  defaultName,
  onOpenChange,
  onCreate,
  onValidationError,
}: CreateRoomFormProps) {
  const [roomName, setRoomName] = useState(defaultName);
  const [isPrivate, setIsPrivate] = useState(false);
  const [password, setPassword] = useState("");
  const [allowSpectators, setAllowSpectators] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
        <div className="space-y-2">
          <Label className="text-sm">房间名称</Label>
          <Input
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            placeholder="输入房间名称"
            className="h-10"
          />
        </div>
        <div className="flex items-center justify-between py-1">
          <Label className="text-sm">私密房间</Label>
          <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
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
                <Label className="text-sm">房间密码</Label>
                <Input
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
        <div className="flex items-center justify-between py-1">
          <Label className="text-sm">允许旁观</Label>
          <Switch checked={allowSpectators} onCheckedChange={setAllowSpectators} />
        </div>
        {errorMessage && (
          <p className="text-xs text-red-500">{errorMessage}</p>
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
