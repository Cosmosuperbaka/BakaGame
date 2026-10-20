import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Popover from "@radix-ui/react-popover";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { popover } from "@/lib/Motion";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/Theme";

const THEME_LABELS: Record<ThemePreference, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

const THEME_OPTIONS = [
  {
    value: "light",
    label: (
      <>
        <Sun className="h-3.5 w-3.5" aria-hidden="true" />
        浅色
      </>
    ),
  },
  {
    value: "dark",
    label: (
      <>
        <Moon className="h-3.5 w-3.5" aria-hidden="true" />
        深色
      </>
    ),
  },
  {
    value: "system",
    label: (
      <>
        <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
        自动
      </>
    ),
  },
] satisfies Array<{ value: ThemePreference; label: ReactNode }>;

/**
 * 顶栏的主题切换器：图标给出当前档位，点开是三选一的分段控件。
 * 三档都写出来而不是循环切换：`system` 与某一固定档在当下可能呈现同一颜色，
 * 只靠图标循环读不出「现在是跟随系统还是手动锁定」。
 */
export function ThemeToggle() {
  const preference = useThemePreference();
  const [open, setOpen] = useState(false);
  const Icon = preference === "light" ? Sun : preference === "dark" ? Moon : Monitor;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`主题：${THEME_LABELS[preference]}`}
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
                className="z-popover w-60 origin-(--radix-popover-content-transform-origin) floating-surface p-3 shadow-md"
              >
                <div className="mb-2 text-xs font-semibold text-muted-foreground">主题</div>
                <SegmentedControl
                  value={preference}
                  options={THEME_OPTIONS}
                  onValueChange={setThemePreference}
                  size="sm"
                  aria-label="主题"
                  className="w-full [&_label]:gap-1.5"
                />
                <p className="mt-2 text-2xs text-muted-foreground">
                  跟随系统会随系统外观自动切换。
                </p>
              </motion.div>
            </Popover.Content>
          </Popover.Portal>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}
