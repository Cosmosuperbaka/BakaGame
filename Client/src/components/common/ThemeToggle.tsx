import { useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SlidingIndicator } from "@/components/ui/SlidingIndicator";
import { useIndicatorRect } from "@/hooks/UseIndicatorRect";
import { popover, tappable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/Theme";

/**
 * 三档都写出来而不是循环切换：`system` 与某一固定档在当下可能呈现同一颜色，
 * 只靠图标循环读不出「现在是跟随系统还是手动锁定」。
 * 标签用全称，与触发按钮的可访问名同一口径。
 */
const THEME_OPTIONS: readonly { value: ThemePreference; label: string; Icon: LucideIcon }[] = [
  { value: "light", label: "浅色", Icon: Sun },
  { value: "dark", label: "深色", Icon: Moon },
  { value: "system", label: "跟随系统", Icon: Monitor },
];

const TRIGGER_ICONS: Record<ThemePreference, LucideIcon> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

const LABELS: Record<ThemePreference, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

/**
 * 浮层里的档位列表：只在打开时挂载，指示器的测量随浮层一起从头跑。
 *
 * 每档一行、图标收在固定的图标列里，图标与文字因此处在同一行盒上——
 * 分段胶囊把图标和文字挤进同一格时，两者会因 `svg` 的块级显示而上下错位。
 * 选中档沿用 `SlidingIndicator` 的方格底块，与队伍选择、分段控件同一种指示。
 */
function ThemeOptions({
  preference,
  labelledBy,
}: {
  preference: ThemePreference;
  labelledBy: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const groupName = useId();
  const rect = useIndicatorRect(rootRef, "[data-checked]", preference);

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="relative flex flex-col"
    >
      <SlidingIndicator rect={rect} />
      {THEME_OPTIONS.map((option) => {
        const checked = option.value === preference;
        return (
          <motion.label
            key={option.value}
            {...tappable}
            // 视觉隐藏的原生 radio 才是聚焦停靠点；label 只承载按压动画。
            tabIndex={-1}
            data-checked={checked || undefined}
            className={cn(
              "relative flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-sm transition-colors",
              "has-focus-visible:outline-2 has-focus-visible:outline-ring",
              checked ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <input
              type="radio"
              name={groupName}
              value={option.value}
              checked={checked}
              onChange={() => setThemePreference(option.value)}
              className="sr-only"
            />
            <option.Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
          </motion.label>
        );
      })}
    </div>
  );
}

/** 顶栏的主题切换器：图标给出当前档位，点开是三选一的档位列表。 */
export function ThemeToggle() {
  const preference = useThemePreference();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const Icon = TRIGGER_ICONS[preference];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`主题：${LABELS[preference]}`}
        >
          <Icon aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <AnimatePresence>
        {open ? (
          <Popover.Portal forceMount>
            <Popover.Content
              forceMount
              side="bottom"
              align="end"
              sideOffset={6}
              collisionPadding={12}
              asChild
            >
              <motion.div
                variants={popover}
                initial="initial"
                animate="animate"
                exit="exit"
                className="z-popover w-44 origin-(--radix-popover-content-transform-origin) floating-surface p-1.5 shadow-md"
              >
                <div
                  id={titleId}
                  className="px-2.5 pb-1 pt-1.5 text-xs font-semibold text-muted-foreground"
                >
                  主题
                </div>
                <ThemeOptions preference={preference} labelledBy={titleId} />
              </motion.div>
            </Popover.Content>
          </Popover.Portal>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}
