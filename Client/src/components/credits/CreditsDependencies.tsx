import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import {
  creditLicenseLabel,
  creditLicenseOptions,
  filterCreditDependencies,
  type CreditDependency,
} from "@/lib/Credits";
import { tappable } from "@/lib/Motion";
import { DependencyListHeader, DependencyRow } from "./DependencyRow";

/** License 筛选里代表「不过滤」的值；Radix Select 的值必须是字符串。 */
const ALL_LICENSES = "all";

/**
 * 依赖清单：一级只列 Client 的直接依赖（主包），搜索、License 筛选与计数都作用在这批主包上；
 * 传递依赖在点击某一行后进入的二级抽屉里展开，避免把上百个包平铺成一张表。
 *
 * 筛选完全由 `filterCreditDependencies` / `creditLicenseOptions` 派生，组件内不复制匹配规则；
 * 整行是按钮，按压取 `optionTappable`（行宽接近列表宽度，只读出「按下了」）。
 */
export function CreditsDependencies({
  dependencies,
  onSelect,
}: {
  dependencies: readonly CreditDependency[];
  /** 打开某个主包的依赖详情抽屉，传包名（下钻栈由页面维护）。 */
  onSelect: (name: string) => void;
}) {
  const mainPackages = useMemo(
    () => dependencies.filter((dependency) => dependency.direct),
    [dependencies]
  );
  const [query, setQuery] = useState("");
  const [license, setLicense] = useState<string | null>(null);
  const visible = useMemo(
    () => filterCreditDependencies(mainPackages, query, license),
    [mainPackages, query, license]
  );
  const options = useMemo(() => creditLicenseOptions(mainPackages), [mainPackages]);

  const clearFilters = () => {
    setQuery("");
    setLicense(null);
  };

  return (
    <section aria-labelledby="credits-dependencies-heading">
      <h2 id="credits-dependencies-heading" className="text-base font-semibold">
        依赖清单
      </h2>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* 与 SearchCombobox 同一套 field-frame 外框：图标在框内、清除按钮只在有内容时出现。 */}
        <div className="field-frame flex h-9 w-full min-w-0 items-center gap-2 rounded-md bg-background px-2.5 sm:w-auto sm:max-w-xs sm:flex-1">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            // 用 text 而不是 search：WebKit 的 search 输入框自带原生清除钮，会与框内这枚 X 重复。
            // role 仍显式声明为 searchbox，读屏与测试按搜索框识别。
            type="text"
            role="searchbox"
            aria-label="搜索依赖"
            placeholder="搜索包名、版本或 License"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground"
          />
          {query ? (
            <motion.button
              type="button"
              aria-label="清除搜索"
              onClick={() => setQuery("")}
              {...tappable}
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </motion.button>
          ) : null}
        </div>

        <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">
          <span id="credits-license-label" className="sr-only">
            License 筛选
          </span>
          <Select
            value={license ?? ALL_LICENSES}
            onValueChange={(value) => setLicense(value === ALL_LICENSES ? null : value)}
          >
            <SelectTrigger aria-labelledby="credits-license-label" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_LICENSES}>全部 License</SelectItem>
              {options.map((option) => (
                <SelectItem key={option.license} value={option.license}>
                  {`${creditLicenseLabel(option.license)}（${option.count}）`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
          {visible.length} 个主包
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="mt-2 grid justify-items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-6 py-10 text-center">
          <p className="text-sm font-medium">没有匹配的主包</p>
          <p className="max-w-md text-xs text-muted-foreground">
            换个关键词或 License 条件，或清除筛选查看全部主包。
          </p>
          <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
            清除筛选
          </Button>
        </div>
      ) : (
        <div className="mt-2 overflow-hidden rounded-md border bg-card shadow-2xs">
          <DependencyListHeader />
          <ul className="divide-y divide-border">
            {visible.map((dependency) => (
              <li key={dependency.name}>
                <DependencyRow dependency={dependency} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
