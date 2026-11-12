import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import type { OriginPoint } from "@/lib/Motion";

/**
 * CEE 里「不可撤销或影响他人」操作的二次确认：取消在前、确认用危险色在后。
 * 确认请求在途（`busy`）时拦截一切关闭路径（Esc、点遮罩、取消钮）：弹窗关了请求仍在飞，玩家就看不到结果了。
 */
export function CEEConfirmDialog({
  open,
  onOpenChange,
  origin,
  title,
  description,
  cancelLabel,
  confirmLabel,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 触发按钮的视口坐标，弹窗由此展开；没有触发点时省略。 */
  origin?: OriginPoint | null;
  title: string;
  description: string;
  cancelLabel: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)} origin={origin}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
            data-agent-control="cee.dialog.cancel"
          >
            {cancelLabel}
          </Button>
          <Button
            variant="destructive"
            loading={busy}
            onClick={onConfirm}
            data-agent-control="cee.dialog.confirm"
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
