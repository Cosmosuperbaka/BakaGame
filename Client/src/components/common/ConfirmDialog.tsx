import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { FormAlert } from "@/components/account/FormAlert";
import type { OriginPoint } from "@/lib/motion/Origin";
import { apiErrorMessage } from "@/lib/Api";

/**
 * 危险操作的二次确认：取消在前、确认默认危险色在后；失败文案留在弹窗内。
 * 确认请求在途时拦截一切关闭路径（Esc、点遮罩、取消钮）：弹窗关了请求仍在飞，操作者就看不到结果了。
 * 在途状态两种给法：回调返回 Promise 时组件自己跟踪；调用方已有请求状态时传 `busy` 受控。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  origin,
  title,
  description,
  cancelLabel = "取消",
  confirmLabel,
  destructive = true,
  busy = false,
  agentControlPrefix,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 触发按钮的视口坐标，弹窗由此展开；没有触发点时省略。 */
  origin?: OriginPoint | null;
  title: string;
  description: string;
  cancelLabel?: string;
  confirmLabel: string;
  /** 确认钮是否用危险色；授予类的正向操作传 false。 */
  destructive?: boolean;
  /** 调用方跟踪请求在途时传入；与回调返回的 Promise 任一在途都算忙碌。 */
  busy?: boolean;
  /** Agent 控件标识前缀（如 `cee.dialog`），派生 `.cancel`/`.confirm` 两个 data-agent-control；不传则不加。 */
  agentControlPrefix?: string;
  /** 异步回调返回失败文案、成功返回 null；同步回调只触发操作，在途与否由 `busy` 表达。 */
  onConfirm: () => void | Promise<string | null>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = busy || pending;
  // 确认框由按钮的点击状态打开，没有 Radix 的 Trigger 可回：打开时记下焦点所在的按钮，关闭时还给它，
  // 键盘用户（尤其是嵌在详情弹窗里时）关掉确认框后不会掉到页面顶层。
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const confirm = async () => {
    const request = onConfirm();
    if (!request) return;
    setPending(true);
    setError(null);
    let failure: string | null;
    try {
      failure = await request;
    } catch (cause) {
      // 契约是返回失败文案；回调漏接异常时也不能让弹窗永远忙碌。
      failure = apiErrorMessage(cause, "操作失败，请稍后重试");
    } finally {
      setPending(false);
    }
    if (failure) setError(failure);
    else onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!inFlight) {
          setError(null);
          onOpenChange(next);
        }
      }}
      origin={origin}
    >
      <DialogContent
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          restoreFocusRef.current = active instanceof HTMLElement ? active : null;
        }}
        onCloseAutoFocus={(event) => {
          const target = restoreFocusRef.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? <FormAlert>{error}</FormAlert> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={inFlight}
            onClick={() => onOpenChange(false)}
            data-agent-control={agentControlPrefix ? `${agentControlPrefix}.cancel` : undefined}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            loading={inFlight}
            onClick={() => void confirm()}
            data-agent-control={agentControlPrefix ? `${agentControlPrefix}.confirm` : undefined}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
