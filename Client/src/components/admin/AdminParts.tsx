import { Fragment, type ComponentProps, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, RotateCw } from "lucide-react";
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
import { SettingSelect } from "@/components/common/room/settings/ChoiceFields";
import { SettingsFields } from "@/components/common/room/settings/Layout";
import type { AdminQuery } from "@/hooks/UseAdminQuery";
import { useScrollFade } from "@/hooks/UseScrollFade";
import { formatNumber } from "@/lib/AdminFormat";
import { cn } from "@/lib/Utils";

/** 面板的标题行：标题与计数在左，筛选与刷新在右，窄屏换行。 */
export function AdminToolbar({
  title,
  count,
  children,
  onReload,
  loading,
  compact = false,
}: {
  title: string;
  count?: number | null;
  children?: ReactNode;
  onReload?: () => void;
  loading?: boolean;
  /**
   * 筛选控件是 sm 高度（如概览的分段控件）时传入。缺省时刷新按钮与面板筛选用的
   * SettingSelect / SettingTextField（h-9）同高，底边对齐的一排控件才不会一高一矮。
   */
  compact?: boolean;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        {title}
        {count === null || count === undefined ? null : (
          // 计数不用等宽字体：等宽体的 0 带斜杠，空列表的「0」读成字母 Ø。
          <span className="font-sans text-sm font-normal tabular-nums text-muted-foreground">
            {formatNumber(count)}
          </span>
        )}
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        {children}
        {onReload ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={compact ? undefined : "h-9"}
            loading={loading}
            onClick={onReload}
          >
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

/**
 * 操作结果的一行说明：成功用对勾与成功色，失败用危险色；与 `FormAlert` 同一种「图标 + xs」写法。
 * 成功读作 `status`，失败读作 `alert`。
 */
export function AdminNotice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error";
  children: ReactNode;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-1.5 text-xs leading-relaxed",
        tone === "error" ? "text-destructive" : "text-success"
      )}
    >
      <CircleCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** 详情读取（弹窗里的单条数据）的占位：加载、失败与重试，没有空态。 */
export function QueryStatus({
  query,
  hasData = Boolean(query.data),
}: {
  query: AdminQuery<unknown>;
  /** 数据来自读取之外的覆盖层（如回复后直接返回的新数据）时自行给出。 */
  hasData?: boolean;
}) {
  return (
    <QueryState
      loading={query.loading}
      error={query.error}
      empty={false}
      hasData={hasData}
      onRetry={query.reload}
      emptyText=""
    />
  );
}

/** 分页列表的占位：首次加载、失败与空列表；有旧数据时不遮挡。 */
export function ListState({
  list,
  emptyText,
}: {
  list: { query: AdminQuery<unknown>; items: unknown[] };
  emptyText: string;
}) {
  const { query, items } = list;
  return (
    <QueryState
      loading={query.loading}
      error={query.error}
      empty={Boolean(query.data) && !items.length}
      hasData={Boolean(query.data)}
      onRetry={query.reload}
      emptyText={emptyText}
    />
  );
}

/** 标题行里的下拉筛选：定宽包一层，选项与行为同 `SettingSelect`。 */
export function AdminFilterSelect({
  width,
  ...props
}: { width: string } & ComponentProps<typeof SettingSelect>) {
  return (
    <div className={width}>
      <SettingSelect {...props} />
    </div>
  );
}

/** 列表行点开的详情弹窗：关闭时只通知调用方清掉选中项。 */
export function AdminDetailDialog({
  open,
  onClose,
  title,
  titleClassName,
  description,
  contentClassName = "sm:max-w-2xl",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  titleClassName?: string;
  description: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className={contentClassName}>
        <DialogHeader>
          <DialogTitle className={titleClassName}>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
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
  const [, scrollerRef] = useScrollFade<HTMLDivElement>("x");
  return (
    // 外框管描边与底色，内层负责横滑：边缘淡出的遮罩只裁表格内容，不裁外框（窄屏看得出右侧还有列）。
    <div className={cn("overflow-hidden rounded-md border bg-card", className)}>
      {/* relative：表格里的 sr-only 等绝对定位元素以滚动容器为包含块，才会被一起裁进横向滚动区；
        否则它们按静态位置落在表格最右侧，把整页撑出横向滚动条。 */}
      <div ref={scrollerRef} className="scrollbar-hidden scroll-fade-x relative">
        <table
          aria-label={label}
          // 单元格默认样式放在 :where() 里：特异性降到最低，列上自己写的 text-right、font-normal 直接生效，
          // 调用处不必再用 `!` 去压表格的后代选择器。
          className="w-full min-w-160 text-sm [:where(&)_td]:px-3 [:where(&)_td]:py-2 [:where(&)_th]:px-3 [:where(&)_th]:py-2 [:where(&)_th]:text-left [:where(&)_th]:font-medium [:where(&)_th]:text-muted-foreground [&_thead]:border-b [&_tbody_tr+tr]:border-t"
        >
          {children}
        </table>
      </div>
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
          {/* 间隔号粘在前一段末尾：换行只发生在间隔号之后，下一行不会以「·」开头。 */}
          {parts.map((part, index) => (
            <Fragment key={`${index}:${part}`}>
              {index ? " " : null}
              <span className="whitespace-nowrap">
                {part}
                {index < parts.length - 1 ? " ·" : null}
              </span>
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
      // 块级且不超过单元格：里面的 truncate 才有可截断的宽度；行内按钮会让长标题溢出单元格、压到右边几列上。
      className="block min-w-0 max-w-full cursor-pointer text-left font-medium underline-offset-4 hover:underline focus-visible:underline"
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
        size="icon-sm"
        aria-label="上一页"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        <ChevronLeft />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
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
    // 限宽：表格按内容分配列宽，一个超长昵称会把账号列撑到半张表宽、手机上只剩这一列可见。
    <span className="flex min-w-0 max-w-64 items-center gap-2">
      <PlayerAvatar name={user.name} image={user.image} className="h-6 w-6 text-xs" />
      <span className="min-w-0">
        <span className="block truncate">{user.name}</span>
        <span className="block font-mono text-xs text-muted-foreground">{user.qqNumber}</span>
      </span>
    </span>
  );
}

/** 「标题 + 字段 + 失败说明 + 取消/确认」的表单弹窗外壳；请求在途时不能关闭。 */
export function AdminFormDialog({
  title,
  description,
  busy,
  error,
  submitLabel,
  submitDisabled = false,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  description: ReactNode;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  submitDisabled?: boolean;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(next) => !busy && !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <SettingsFields>{children}</SettingsFields>
        {error ? <FormAlert>{error}</FormAlert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="button" loading={busy} disabled={submitDisabled} onClick={onSubmit}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
