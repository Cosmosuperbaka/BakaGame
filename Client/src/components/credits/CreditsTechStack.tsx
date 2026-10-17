import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import type { CoreTechEntry, CreditDependency } from "@/lib/Credits";
import { pressable } from "@/lib/Motion";
import { TechStackGlyph } from "./CreditsIcons";

/** 依赖清单里同一个包名可能出现多次（直接依赖与传递依赖各有一条），取第一条的版本即可。 */
function versionIndex(dependencies: readonly CreditDependency[]): Map<string, string> {
  const versions = new Map<string, string>();
  for (const dependency of dependencies) {
    if (!versions.has(dependency.name)) versions.set(dependency.name, dependency.version);
  }
  return versions;
}

/**
 * 核心技术栈：整卡是外链，指向官方站点；版本从依赖清单按 `packageName` 取实际安装值，
 * 取不到（非 npm 运行时，如 Bun）就不显示版本，不写占位。
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
  return (
    <section aria-labelledby="credits-tech-heading">
      <h2 id="credits-tech-heading" className="text-base font-semibold">
        核心技术栈
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        支撑页面与服务的框架和工具，版本取自本次构建实际安装的依赖。
      </p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {techStack.map((entry) => {
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
                  <TechStackGlyph icon={entry.icon} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate text-sm font-medium">{entry.name}</span>
                    {version ? (
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">v{version}</span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-xs break-words text-muted-foreground">{entry.role}</span>
                </span>
                {/* 与 LandingPage 的外链指示一致：图标只做装饰，可访问名由卡片文字给出。 */}
                <ArrowUpRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                />
              </motion.a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
