import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import type { OriginPoint } from "@/lib/Motion";

export interface JoinPasswordDialogProps {
  /** 待加入的房间名；为 null 时弹窗关闭 */
  roomName: string | null;
  /** 触发卡片的位置，弹窗由此展开 */
  origin?: OriginPoint | null;
  password: string;
  onPasswordChange: (password: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 大厅点开带锁房间时的密码输入。 */
export function JoinPasswordDialog({
  roomName,
  origin,
  password,
  onPasswordChange,
  onCancel,
  onConfirm,
}: JoinPasswordDialogProps) {
  return (
    <Dialog open={roomName !== null} onOpenChange={(open) => { if (!open) onCancel(); }} origin={origin}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>输入房间密码</DialogTitle>
          <DialogDescription>房间 &ldquo;{roomName}&rdquo; 需要密码</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm();
          }}
        >
          <Input
            autoFocus
            type="password"
            aria-label="房间密码"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder="请输入密码"
            className="h-10 text-base"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>取消</Button>
            <Button type="submit">加入</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
