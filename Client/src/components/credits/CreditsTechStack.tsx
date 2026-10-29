import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { TECH_STACK_CATEGORIES } from "@/data/CreditsContent";
import type { CoreTechEntry, CreditDependency } from "@/lib/Credits";
import { pressable } from "@/lib/Motion";
import { CreditBrandMark } from "./CreditsIcons";

/**
 * 按包名取展示版本；取不到（非 npm 运行时）不写占位。
 *
 * 同一个包名可能对应多条安装：npm 别名（`typescript7` 装的是 TypeScript 7）与
 * 传递副本会撞名。核心技术栈要展示项目实际声明的那条，因此同名时直接依赖优先，
 * 纯传递副本不得顶替；同类直接依赖撞名时保留清单里靠前的一条。
 */
function versionIndex(dependencies: readonly CreditDependency[]): Map<string, string> {
  const versions = new Map<string, string>();
  const directNames = new Set<string>();
  for (const dependency of dependencies) {
    if (!dependency.direct) {
      if (!versions.has(dependency.name)) versions.set(dependency.name, dependency.version);
      continue;
    }
    if (directNames.has(dependency.name)) continue;
    directNames.add(dependency.name);
    versions.set(dependency.name, dependency.version);
  }
  return versions;
}

/**
 * 核心技术栈：按 `TECH_STACK_CATEGORIES` 的声明顺序分四组，每组一个 h3 分组标题与卡片网格；
 * 分组顺序与标题只在数据文件里维护，这里不复制一份口径。
 *
 * 整卡是外链，指向官方站点；版本从依赖清单按 `packageName` 取实际安装值。
 * 悬停沿用流内可点卡片的 `accent/40` 底色，按压取 `pressable`。
 */
export function CreditsTechStack({
  techStack,
  dependencies,
}: {
  techStack: readonly CoreTechEntry[];
  dependencies: readonly CreditDependency[];
}) {
  const versions = versionIndex(dependencies);
  // 先按分组顺序收口，空分组不渲染标题，避免出现只有标题没有内容的区块。
  const groups = TECH_STACK_CATEGORIES.map((category) => ({
    ...category,
    entries: techStack.filter((entry) => entry.category === category.id),
  })).filter((group) => group.entries.length > 0);

  return (
    <section aria-labelledby="credits-tech-heading">
      <h2 id="credits-tech-heading" className="text-base font-semibold">
        核心技术栈
      </h2>
      <div className="mt-3 space-y-5">
        {groups.map((group) => (
          <section key={group.id} aria-labelledby={`credits-tech-${group.id}`}>
            <h3 id={`credits-tech-${group.id}`} className="text-sm font-semibold">
              {group.label}
            </h3>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {group.entries.map((entry) => {
                const version = entry.packageName ? versions.get(entry.packageName) : undefined;
                return (
                  <li key={entry.name} className="min-w-0">
                    <motion.a
                      href={entry.url}
                      target="_blank"
                      rel="noreferrer"
                      {...pressable}
                      className="group flex h-full min-w-0 items-start gap-3 rounded-md border bg-card p-3 text-left shadow-2xs transition-colors hover:bg-accent/40"
                    >
                      <span
                        aria-hidden="true"
                        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
                      >
                        <CreditBrandMark brand={entry.icon} className="size-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-1.5">
                          <span className="truncate font-serif text-sm font-medium">
                            {entry.name}
                          </span>
                          {version ? (
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              v{version}
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-xs break-words text-muted-foreground">
                          {entry.role}
                        </span>
                      </span>
                      {/* 外链指示：静止时压淡，悬停沿外链方向挪动并归位到不透明，只作装饰、不承载状态。 */}
                      <ArrowUpRight
                        aria-hidden="true"
                        className="size-3.5 shrink-0 opacity-40 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
                      />
                    </motion.a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}
