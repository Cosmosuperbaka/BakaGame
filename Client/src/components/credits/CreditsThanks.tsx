import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import type { SpecialThanksEntry } from "@/lib/Credits";
import { pressable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { ThanksGlyph } from "./CreditsIcons";

const CARD_CLASS =
  "flex h-full min-w-0 items-start gap-3 rounded-md border bg-card p-3 shadow-2xs";

/**
 * 图标收在一枚固定尺寸的方块里：条目多起来时左缘成一条直线。
 * 方块与字形尺寸、外链箭头的位置与浓度都与紧挨着的「核心技术栈」卡片同一套，两组卡片读作同一种东西。
 */
const ICON_TILE_CLASS =
  "flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground";

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
                <ThanksContent entry={entry} withArrow />
              </motion.a>
            ) : (
              <div className={CARD_CLASS}>
                <ThanksContent entry={entry} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ThanksContent({
  entry,
  withArrow = false,
}: {
  entry: SpecialThanksEntry;
  withArrow?: boolean;
}) {
  return (
    <>
      <span data-slot="thanks-icon" className={ICON_TILE_CLASS}>
        <ThanksGlyph icon={entry.icon} className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-serif text-sm font-medium">{entry.name}</span>
        <span className="mt-0.5 block text-xs break-words text-muted-foreground">
          {entry.description}
        </span>
      </span>
      {/* 外链指示：卡片右上角、静止压淡，悬停沿外链方向挪动并归位到不透明（与技术栈卡片一致）。 */}
      {withArrow ? (
        <ArrowUpRight
          aria-hidden="true"
          className="size-3.5 shrink-0 opacity-40 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
        />
      ) : null}
    </>
  );
}
