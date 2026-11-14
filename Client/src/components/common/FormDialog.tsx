import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";

interface FormDialogProps {
  title: string;
  /** null：不渲染描述（建房现状）；调用方据此给 DialogContent 传 aria-describedby={undefined}。 */
  description: ReactNode | null;
  cancelLabel: string;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: () => void;
  /** 提交按钮的禁用条件；建房传 false（现状不禁用）。 */
  submitDisabled: boolean;
  /** 提交在途：按钮转圈并禁用，且不再触发 onSubmit。 */
  pending: boolean;
  /** 表单字段；建房自带 div.space-y-5，外壳不加包层。 */
  children: ReactNode;
}

/**
 * 表单弹窗的内层壳：标题区 + 表单网格 + 底部按钮区。
 * Dialog 与 DialogContent 留在各调用方，表单状态随弹窗关闭即卸载复位，渲染出的 DOM 与生命周期都不变。
 * 各弹窗的差异（有无描述、提交禁用条件、按钮文案）经参数传入。
 */
export function FormDialog({
  title,
  description,
  cancelLabel,
  submitLabel,
  onCancel,
  onSubmit,
  submitDisabled,
  pending,
  children,
}: FormDialogProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description !== null ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitDisabled && !pending) onSubmit();
        }}
      >
        {children}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button type="submit" disabled={submitDisabled} loading={pending}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
