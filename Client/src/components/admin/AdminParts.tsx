import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Spinner } from "@/components/ui/Spinner";
import { PlayerAvatar } from "@/components/common/PlayerAvatar";
import { formatNumber } from "@/lib/AdminFormat";
import { cn } from "@/lib/Utils";

/** 面板的标题行：标题与计数在左，筛选与刷新在右，窄屏换行。 */
export function AdminToolbar({
  title,
  count,
  children,
  onReload,
  loading,
}: {
  title: string;
  count?: number | null;
  children?: ReactNode;
  onReload?: () => void;
  loading?: boolean;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        {title}
        {count === null || count === undefined ? null : (
          <span className="font-mono text-sm font-normal text-muted-foreground">
            {formatNumber(count)}
          </span>
        )}
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        {children}
        {onReload ? (
          <Button type="button" variant="outline" size="sm" loading={loading} onClick={onReload}>
            <RotateCw />
            刷新
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** 首次加载、失败与空列表的占位；有旧数据时不遮挡，失败文案写在表格上方。 */
export function QueryState({
  loading,
  error,
  empty,
  hasData,
  onRetry,
  emptyText,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  hasData: boolean;
  onRetry: () => void;
  emptyText: string;
}) {
  if (error) {
    return (
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
        <span role="alert" className="text-destructive">
          {error}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          重试
        </Button>
      </div>
    );
  }
  if (!hasData && loading) {
    return (
      <div role="status" className="flex justify-center py-12">
        <Spinner className="size-5 text-muted-foreground" />
        <span className="sr-only">加载中</span>
      </div>
    );
  }
  if (empty)
    return (
      <p className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
        {emptyText}
      </p>
    );
  return null;
}

/** 表格外框：窄屏横向滚动，表头弱化、行间细线。 */
export function AdminTable({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("overflow-x-auto rounded-md border bg-card", className)}>
      <table
        aria-label={label}
        className="w-full min-w-[40rem] text-sm [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground [&_thead]:border-b [&_tbody_tr+tr]:border-t"
      >
        {children}
      </table>
    </div>
  );
}

/** 表格行里打开详情的入口：整格是一个按钮，键盘可达。 */
export function RowButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-w-0 cursor-pointer text-left font-medium underline-offset-4 hover:underline focus-visible:underline"
    >
      {children}
    </button>
  );
}

export function Pager({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  if (total <= limit) return null;
  const end = Math.min(total, offset + limit);
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-sm text-muted-foreground">
      <span className="tabular-nums">
        {offset + 1}–{end} / {formatNumber(total)}
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-8"
        aria-label="上一页"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        <ChevronLeft />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-8"
        aria-label="下一页"
        disabled={end >= total}
        onClick={() => onChange(offset + limit)}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}

/** 账号的头像、昵称与 QQ 号；账号已注销时写「已注销」。 */
export function UserCell({
  user,
  fallback = "已注销",
}: {
  user: { name: string; qqNumber: string; image: string | null } | null;
  fallback?: string;
}) {
  if (!user) return <span className="text-muted-foreground">{fallback}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <PlayerAvatar name={user.name} image={user.image} className="h-6 w-6 text-xs" />
      <span className="min-w-0">
        <span className="block truncate">{user.name}</span>
        <span className="block font-mono text-xs text-muted-foreground">{user.qqNumber}</span>
      </span>
    </span>
  );
}

/** 危险操作的二次确认；失败文案留在弹窗内。 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  /** 返回失败文案，成功返回 null。 */
  onConfirm: () => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    const failure = await onConfirm();
    setBusy(false);
    if (failure) setError(failure);
    else onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setError(null);
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type="button" variant="destructive" loading={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
