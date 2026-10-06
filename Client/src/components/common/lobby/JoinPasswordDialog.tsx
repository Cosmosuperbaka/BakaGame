import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { RoomPasswordField, type RoomPasswordError } from "@/components/common/room/RoomJoinGate";
import type { OriginPoint } from "@/lib/Motion";

export interface JoinPasswordDialogProps {
  /** 待加入的房间名；为 null 时弹窗关闭 */
  roomName: string | null;
  /** 触发卡片的位置，弹窗由此展开 */
  origin?: OriginPoint | null;
  pending?: boolean;
  password: string;
  onPasswordChange: (password: string) => void;
  /** 上一次加入失败的文案，写在密码框下方；密码错误时同时标红输入框 */
  error?: RoomPasswordError | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 大厅点开带锁房间时的密码输入。与分享链接进房的密码弹窗同一种写法（`RoomPasswordField`）。 */
export function JoinPasswordDialog({
  roomName,
  pending = false,
  origin,
  password,
  onPasswordChange,
  error,
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
            if (password.trim() && !pending) onConfirm();
          }}
        >
          <RoomPasswordField value={password} onChange={onPasswordChange} error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>取消</Button>
            <Button type="submit" disabled={!password.trim()} loading={pending}>加入</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
