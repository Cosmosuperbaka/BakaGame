import { motion } from "framer-motion";
import { ChevronRight, GitFork } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Hint } from "@/components/ui/Tooltip";
import { creditLicenseLabel, type CreditDependency } from "@/lib/Credits";
import { optionTappable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { DependencyGlyph } from "./CreditsIcons";

/**
 * 依赖行的列轨。对齐靠列轨而不是每列各自 `w-*`：可变宽度的列（子依赖数、类型徽章）夹在
 * 包名与版本之间时，版本列会随每行内容左右跳动。这里每列都是固定 rem 轨，且**每行都渲染
 * 每一列**（没有内容时给一个占位 `—`），列与列之间因此是一条直线而不是逐行重排。
 *
 * 窄屏用 `hidden` 摘掉子依赖、类型与 License 三列，只剩「图标 · 包名 · 版本 · 箭头」四格，
 * 所以两套列轨的格数分别是 4 与 7（compact 宽屏 6）。少一格都会让版本列错位。
 * `compact` 给二级抽屉用：抽屉只有 32rem 宽，且子依赖已按类型分组，类型列是重复信息。
 */
const NARROW_TRACKS = "grid-cols-[auto_minmax(0,1fr)_5rem_auto]";
const ROW_GRID = {
  full: "sm:grid-cols-[auto_minmax(0,1fr)_4.5rem_5.5rem_5.5rem_7rem_auto]",
  compact: "sm:grid-cols-[auto_minmax(0,1fr)_4.5rem_5rem_6.5rem_auto]",
} as const;

/** 空列的占位：不写文字，只把这一格标成「确实没有」，保持列轨不被压缩。 */
function EmptyCell() {
  return (
    <span aria-hidden="true" className="text-center text-xs text-muted-foreground/50">
      —
    </span>
  );
}

const rowClass = (compact: boolean) =>
  cn(NARROW_TRACKS, ROW_GRID[compact ? "compact" : "full"], "gap-x-2.5 px-3 py-2");

/** 列标题：与 `DependencyRow` 共用同一套列轨，标题与数据逐列对齐。 */
export function DependencyListHeader({ compact = false }: { compact?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        rowClass(compact),
        "grid items-center border-b bg-muted/40 font-sans text-2xs text-muted-foreground"
      )}
    >
      <span />
      <span className="min-w-0">包名</span>
      <span className="hidden text-center sm:block">子依赖</span>
      <span className="text-right">版本</span>
      {compact ? null : <span className="hidden text-center sm:block">类型</span>}
      <span className="hidden text-center sm:block">License</span>
      <span />
    </div>
  );
}

/**
 * 一行一个依赖。`onSelect` 给出时整行可点、打开该包的二级抽屉；省略时渲染成静态行。
 */
export function DependencyRow({
  dependency,
  onSelect,
  compact = false,
}: {
  dependency: CreditDependency;
  onSelect?: (name: string) => void;
  /** 抽屉内的窄行：去掉类型列，其余列仍然逐列对齐。 */
  compact?: boolean;
}) {
  const childCount = dependency.dependencies.length;
  const isDevelopment = dependency.scope === "development";

  const content = (
    <>
      <DependencyGlyph packageName={dependency.name} className="text-muted-foreground" />
      <Hint label={dependency.name}>
        <span className="min-w-0 truncate text-sm">{dependency.name}</span>
      </Hint>
      {/* 子依赖数配一枚分叉图标：预告抽屉里还能往下看；0 个给占位而不是空一格。 */}
      <span
        data-slot="dep-children"
        className="hidden items-center justify-center gap-1 text-2xs tabular-nums text-muted-foreground sm:flex"
      >
        {childCount > 0 ? (
          <>
            <GitFork aria-hidden="true" className="size-3 shrink-0 opacity-60" />
            {childCount}
          </>
        ) : (
          <EmptyCell />
        )}
      </span>
      <span
        data-slot="dep-version"
        className="text-right font-mono text-xs tabular-nums text-muted-foreground"
      >
        v{dependency.version}
      </span>
      {compact ? null : (
        <span data-slot="dep-type" className="hidden items-center justify-center sm:flex">
          {isDevelopment ? (
            <Badge variant="subtle" size="xs">
              开发依赖
            </Badge>
          ) : (
            <EmptyCell />
          )}
        </span>
      )}
      <span data-slot="dep-license" className="hidden items-center justify-center sm:flex">
        {/* 徽章正文就是许可证名：被列宽截断的部分由整行可访问名与抽屉详情补。 */}
        <Badge variant="outline" size="xs" className="min-w-0 max-w-full">
          <span className="truncate">{creditLicenseLabel(dependency.license)}</span>
        </Badge>
      </span>
      <ChevronRight
        className="size-4 shrink-0 justify-self-end text-muted-foreground"
        aria-hidden="true"
      />
    </>
  );

  if (!onSelect) {
    return (
      <div className={cn(rowClass(compact), "grid items-center")} aria-label={dependency.name}>
        {content}
      </div>
    );
  }

  return (
    <motion.button
      type="button"
      onClick={() => onSelect(dependency.name)}
      {...optionTappable}
      aria-label={`查看 ${dependency.name} v${dependency.version}（${creditLicenseLabel(
        dependency.license
      )}${isDevelopment ? "，开发依赖" : ""}）的依赖详情`}
      className={cn(
        rowClass(compact),
        "grid w-full min-w-0 cursor-pointer items-center text-left transition-colors hover:bg-accent/40 focus-visible:-outline-offset-2"
      )}
    >
      {content}
    </motion.button>
  );
}
