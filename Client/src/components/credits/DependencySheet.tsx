import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowUpRight, ChevronRight, Globe, Package } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Collapsible } from "@/components/ui/Collapsible";
import {
  collectTransitiveDependencyNames,
  creditLicenseLabel,
  type CreditDependency,
  type CreditLicenseDocument,
} from "@/lib/Credits";
import { optionTappable, pressable } from "@/lib/Motion";
import { DependencyGlyph } from "./CreditsIcons";
import { DependencyLicense } from "./DependencyLicense";

/**
 * 二级抽屉的内容：包身份 → 跳转按钮 → 依赖构成与子依赖 → 许可证原文。
 *
 * 抽屉本身是页面级的一个 `Sheet`，`path` 是页面维护的下钻栈：长度为 1 时是直接从主包打开，
 * 大于 1 时才出现「返回上一层」，点击子依赖由页面 push 一层，因此抽屉的开合焦点行为不变。
 * 许可证原文默认折叠，展开才挂载正文并调用 `loadLicense`，不让法律原文占满首屏。
 */
export function DependencySheet({
  dependency,
  byName,
  path,
  onNavigate,
  onBack,
  loadLicense,
}: {
  dependency: CreditDependency;
  /** 全量依赖索引，用来把子依赖包名解析成条目并统计传递闭包。 */
  byName: ReadonlyMap<string, CreditDependency>;
  /** 页面维护的下钻栈，最后一项是当前包；长度大于 1 时显示返回。 */
  path: readonly string[];
  onNavigate: (name: string) => void;
  onBack: () => void;
  loadLicense: (packageName: string) => Promise<CreditLicenseDocument | null>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const parentName = path.length > 1 ? path[path.length - 2] : null;

  // 下钻后回到顶部：抽屉内容区是 Sheet 里的滚动容器，换包时若停在上一级的滚动位置，
  // 一进来就错过包名与跳转按钮。向上找第一个真正可滚动的祖先并归零；
  // jsdom 没有布局（scrollHeight 与 clientHeight 都是 0），不会误触。
  useEffect(() => {
    let node = rootRef.current?.parentElement ?? null;
    while (node) {
      if (node.scrollHeight > node.clientHeight) {
        node.scrollTop = 0;
        return;
      }
      node = node.parentElement;
    }
  }, [dependency.name]);

  // 构建期保证子依赖都在清单里；坏数据里缺项时跳过，不让抽屉整块渲染失败。
  const childDependencies = dependency.dependencies
    .map((name) => byName.get(name))
    .filter((child): child is CreditDependency => child !== undefined);
  // 间接依赖取传递闭包（不含当前包），与「直接子依赖」分开计数。
  const transitiveCount = collectTransitiveDependencyNames(byName, dependency.name).length;
  const scopeLabel =
    dependency.scope === "development" ? "开发依赖" : dependency.direct ? "直接依赖" : "运行时依赖";

  return (
    <div ref={rootRef} className="space-y-4">
      {parentName ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 max-w-full justify-start gap-1.5 px-2 text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" />
          <span className="min-w-0 truncate">返回 {parentName}</span>
        </Button>
      ) : null}

      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
        >
          <DependencyGlyph packageName={dependency.name} className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-lg font-semibold break-all font-mono">{dependency.name}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" size="xs" className="font-mono">
              v{dependency.version}
            </Badge>
            <Badge variant="secondary" size="xs">
              {creditLicenseLabel(dependency.license)}
            </Badge>
            <Badge variant="subtle" size="xs">
              {scopeLabel}
            </Badge>
          </div>
        </div>
      </div>

      {dependency.description ? (
        <p className="text-sm break-words text-muted-foreground">{dependency.description}</p>
      ) : null}

      {/* 跳转用整行描边按钮，不再是一小行文字链：这是抽屉里最常做的外部动作。 */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {dependency.url ? (
          <Button asChild variant="outline" className="group justify-start">
            <motion.a href={dependency.url} target="_blank" rel="noreferrer" {...pressable}>
              <Globe aria-hidden="true" />
              <span>项目主页</span>
              <ArrowUpRight
                aria-hidden="true"
                className="ml-auto opacity-40 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
              />
            </motion.a>
          </Button>
        ) : null}
        <Button
          asChild
          variant="outline"
          className={dependency.url ? "group justify-start" : "group justify-start sm:col-span-2"}
        >
          <motion.a
            href={`https://www.npmjs.com/package/${dependency.name}`}
            target="_blank"
            rel="noreferrer"
            {...pressable}
          >
            <Package aria-hidden="true" />
            <span>npm 页面</span>
            <ArrowUpRight
              aria-hidden="true"
              className="ml-auto opacity-40 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
            />
          </motion.a>
        </Button>
      </div>

      <div className="border-t pt-3">
        <p className="text-xs tabular-nums text-muted-foreground">
          直接子依赖 {childDependencies.length} 个 · 间接依赖 {transitiveCount} 个
        </p>
        {childDependencies.length === 0 ? (
          <p className="mt-2 rounded-md border border-dashed border-border bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">
            无子依赖
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-md border bg-card">
            {childDependencies.map((child) => (
              <li key={child.name}>
                <ChildDependencyRow dependency={child} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t pt-3">
        <Collapsible title="许可证原文">
          <DependencyLicense packageName={dependency.name} loadLicense={loadLicense} />
        </Collapsible>
      </div>
    </div>
  );
}

/** 子依赖行：整行可点，点击由页面 push 一层下钻栈。 */
function ChildDependencyRow({
  dependency,
  onNavigate,
}: {
  dependency: CreditDependency;
  onNavigate: (name: string) => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={() => onNavigate(dependency.name)}
      {...optionTappable}
      aria-label={`查看 ${dependency.name} 的依赖详情`}
      className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent/40 focus-visible:-outline-offset-2"
    >
      <DependencyGlyph packageName={dependency.name} className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-sm" title={dependency.name}>
        {dependency.name}
      </span>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">v{dependency.version}</span>
      <span className="hidden shrink-0 sm:flex">
        <Badge variant="outline" size="xs" className="max-w-24 min-w-0">
          <span className="truncate">{creditLicenseLabel(dependency.license)}</span>
        </Badge>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </motion.button>
  );
}
