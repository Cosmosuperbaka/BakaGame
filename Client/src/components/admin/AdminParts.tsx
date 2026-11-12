import { Fragment, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, RotateCw } from "lucide-react";
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
import { FormAlert } from "@/components/account/FormAlert";
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
            {/* 读取中由按钮自己的转圈表示，刷新图标让位：两枚旋转图标并排读不出哪个在转。 */}
            {loading ? null : <RotateCw />}
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
        {/* 失败不只靠红色传达：与弹窗里的 FormAlert 同一个前导图标。 */}
        <span role="alert" className="flex items-center gap-1.5 text-destructive">
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
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
  if (empty) return <EmptyNote className="py-10">{emptyText}</EmptyNote>;
  return null;
}

/** 区块内的空态：虚线框加居中灰字，与列表空态同一写法；小区块传更小的内边距。 */
export function EmptyNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground",
        className
      )}
    >
      {children}
    </p>
  );
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
        // 单元格默认样式放在 :where() 里：特异性降到最低，列上自己写的 text-right、font-normal 直接生效，
        // 调用处不必再用 `!` 去压表格的后代选择器。
        className="w-full min-w-160 text-sm [:where(&)_td]:px-3 [:where(&)_td]:py-2 [:where(&)_th]:px-3 [:where(&)_th]:py-2 [:where(&)_th]:text-left [:where(&)_th]:font-medium [:where(&)_th]:text-muted-foreground [&_thead]:border-b [&_tbody_tr+tr]:border-t"
      >
        {children}
      </table>
    </div>
  );
}

/** 面板顶部的数字卡片。 */
export function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  /** 多段分项传数组：每段整体换行，窄卡片里不会把「已解决 142」拆成两行。 */
  detail?: string | string[];
}) {
  const parts = typeof detail === "string" ? [detail] : (detail ?? []);
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs font-serif text-muted-foreground">{label}</div>
      <div className="mt-1 font-serif text-2xl font-semibold tabular-nums">
        {formatNumber(value)}
      </div>
      {parts.length ? (
        <div className="mt-0.5 text-xs text-muted-foreground">
          {/* 间隔号留在不折行的片段外面：换行只发生在两段之间。 */}
          {parts.map((part, index) => (
            <Fragment key={`${index}:${part}`}>
              {index ? " · " : null}
              <span className="whitespace-nowrap">{part}</span>
            </Fragment>
          ))}
        </div>
      ) : null}
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
        {error ? <FormAlert>{error}</FormAlert> : null}
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
