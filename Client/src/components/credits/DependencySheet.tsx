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
import { pressable } from "@/lib/Motion";
import { DependencyGlyph } from "./CreditsIcons";
import { DependencyLicense } from "./DependencyLicense";
import { DependencyListHeader, DependencyRow } from "./DependencyRow";

/** 下钻路径里的一格：包名与它在栈中的位置，点击回到该层。 */
function Crumb({ name, current, onPick }: { name: string; current: boolean; onPick: () => void }) {
  if (current) {
    return <span className="min-w-0 truncate font-mono text-foreground">{name}</span>;
  }
  return (
    <button
      type="button"
      onClick={onPick}
      className="min-w-0 shrink truncate rounded-sm font-mono text-muted-foreground transition-colors hover:text-foreground focus-visible:-outline-offset-2"
    >
      {name}
    </button>
  );
}

/** 一格统计：数字在上、说明在下，替代「直接子依赖 N 个 · 间接依赖 M 个」这类连读散文。 */
function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="min-w-0 rounded-md bg-muted/40 px-3 py-2">
      <p className="font-mono text-lg leading-tight tabular-nums">{value}</p>
      <p className="mt-0.5 text-2xs text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * 二级抽屉的内容：下钻路径 → 包身份 → 跳转按钮 → 依赖构成 → 许可证原文。
 *
 * 抽屉本身是页面级的一个 `Sheet`，`path` 是页面维护的下钻栈。返回不再是单级的「返回上一层」，
 * 而是整条路径：中间每一格都可点，一次跳回任意已走过的层，深钻后不必逐层退。
 * 子依赖按运行时 / 开发分组，组内行与依赖清单一期共用 `DependencyRow` 的窄变体，逐列对齐。
 * 许可证原文默认折叠，展开才挂载正文并调用 `loadLicense`，不让法律原文占满首屏。
 */
export function DependencySheet({
  dependency,
  byName,
  path,
  onNavigate,
  onRewind,
  loadLicense,
}: {
  dependency: CreditDependency;
  /** 全量依赖索引，用来把子依赖包名解析成条目并统计传递闭包。 */
  byName: ReadonlyMap<string, CreditDependency>;
  /** 页面维护的下钻栈，最后一项是当前包。 */
  path: readonly string[];
  onNavigate: (name: string) => void;
  /** 回到下钻栈的第 `index` 层（含），当前层不回调。 */
  onRewind: (index: number) => void;
  loadLicense: (packageName: string) => Promise<CreditLicenseDocument | null>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

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
  const children = dependency.dependencies
    .map((name) => byName.get(name))
    .filter((child): child is CreditDependency => child !== undefined);
  const runtime = children.filter((child) => child.scope === "runtime");
  const development = children.filter((child) => child.scope === "development");
  // 间接依赖取传递闭包（不含当前包），与「直接子依赖」分开计数。
  const transitiveCount = collectTransitiveDependencyNames(byName, dependency.name).length;
  // 直接/运行时的区分在抽屉里仍然有意义：它说明这个包是自己声明的，还是沿依赖链进来的。
  const scopeLabel =
    dependency.scope === "development" ? "开发依赖" : dependency.direct ? "直接依赖" : "运行时依赖";

  return (
    <div ref={rootRef} className="space-y-4">
      {path.length > 1 ? (
        <nav aria-label="依赖下钻路径" className="min-w-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 gap-1.5 px-2 text-muted-foreground"
            onClick={() => onRewind(path.length - 2)}
          >
            <ArrowLeft aria-hidden="true" />
            <span>返回上一层</span>
          </Button>
          <ol className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1 text-xs">
            {path.map((name, index) => (
              <li key={name} className="flex min-w-0 items-center gap-1">
                {index > 0 ? (
                  <ChevronRight aria-hidden="true" className="size-3 shrink-0 opacity-50" />
                ) : null}
                <Crumb
                  name={name}
                  current={index === path.length - 1}
                  onPick={() => onRewind(index)}
                />
              </li>
            ))}
          </ol>
        </nav>
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
            <Badge variant="outline" size="xs" className="font-mono tabular-nums">
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
        <div className="grid grid-cols-2 gap-2">
          <Stat value={children.length} label="直接子依赖" />
          <Stat value={transitiveCount} label="间接依赖（传递闭包）" />
        </div>

        {children.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-border bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">
            无子依赖
          </p>
        ) : (
          /* 按类型分组：组标题承担「这一堆是什么」，行内就不再重复类型列。 */
          <div className="mt-3 space-y-3">
            {[
              { label: "运行时依赖", entries: runtime },
              { label: "开发依赖", entries: development },
            ]
              .filter((group) => group.entries.length > 0)
              .map((group) => (
                <section key={group.label} aria-label={group.label}>
                  <h3 className="font-sans text-2xs text-muted-foreground">
                    {`${group.label} ${group.entries.length} 个`}
                  </h3>
                  <div className="mt-1 overflow-hidden rounded-md border bg-card">
                    <DependencyListHeader compact />
                    <ul className="divide-y divide-border">
                      {group.entries.map((child) => (
                        <li key={child.name}>
                          <DependencyRow dependency={child} compact onSelect={onNavigate} />
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>
              ))}
          </div>
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
