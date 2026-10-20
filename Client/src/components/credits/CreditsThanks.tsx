import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import type { SpecialThanksEntry } from "@/lib/Credits";
import { pressable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

const CARD_CLASS = "flex h-full min-w-0 flex-col gap-1 rounded-md border bg-card p-3 shadow-2xs";

/**
 * 特别鸣谢：玩法原型、资料站与曲库来源，内容和顺序只在 `data/CreditsContent.ts` 维护。
 * 有外链的整卡可点；仓库或作者尚未确认的来源不生成占位外链，退化为静态卡片。
 */
export function CreditsThanks({ entries }: { entries: readonly SpecialThanksEntry[] }) {
  return (
    <section aria-labelledby="credits-thanks-heading">
      <h2 id="credits-thanks-heading" className="text-base font-semibold">
        特别鸣谢
      </h2>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <li key={entry.name} className="min-w-0">
            {entry.url ? (
              <motion.a
                href={entry.url}
                target="_blank"
                rel="noreferrer"
                {...pressable}
                className={cn(CARD_CLASS, "group transition-colors hover:bg-accent/40")}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{entry.name}</span>
                  {/* 外链指示：静止压淡，悬停沿外链方向挪动并归位到前景色。 */}
                  <ArrowUpRight
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground"
                  />
                </span>
                <span className="text-xs break-words text-muted-foreground">
                  {entry.description}
                </span>
              </motion.a>
            ) : (
              <div className={CARD_CLASS}>
                <span className="text-sm font-medium">{entry.name}</span>
                <span className="text-xs break-words text-muted-foreground">
                  {entry.description}
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
