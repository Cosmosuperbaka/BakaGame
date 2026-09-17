import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, FlaskConical, Minus, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { collapsible, headerTappable, spring } from "@/lib/Motion";
import type { SonGuessrRoomSnapshot } from "@/types";

export interface SongTestControllerProps {
  snapshot: SonGuessrRoomSnapshot;
  run: (type: string, payload?: Record<string, unknown>, success?: string) => Promise<void>;
  isPending?: (type: string) => boolean;
}

export function SongTestController({
  snapshot,
  run,
  isPending,
}: SongTestControllerProps) {
  const [open, setOpen] = useState(true);
  const botCount = snapshot.players.filter((player) => player.isBot).length;

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 right-3 z-30 md:bottom-5 md:left-auto md:right-5">
      <div className="pointer-events-auto flex justify-end">
        <motion.div
          layout
          transition={spring.settle}
          className="w-full max-w-full overflow-hidden rounded-md border bg-background/95 shadow-xl backdrop-blur-md md:w-96"
        >
          <motion.button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            {...headerTappable}
            className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-muted/40"
          >
            <FlaskConical className="h-4 w-4 text-primary" />
            <span>测试控制器</span>
            <motion.span
              aria-hidden="true"
              className="ml-auto inline-flex text-muted-foreground"
              animate={{ rotate: open ? 180 : 0 }}
              transition={spring.snap}
            >
              <ChevronDown className="h-4 w-4" />
            </motion.span>
          </motion.button>
          <AnimatePresence initial={false}>
            {open ? (
              <motion.div
                variants={collapsible}
                initial="initial"
                animate="animate"
                exit="exit"
                className="overflow-hidden"
              >
                <div className="space-y-2 border-t px-4 pb-4 pt-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Users className="h-3.5 w-3.5 text-sky-500" />
                    测试人机
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 flex-1 gap-1 text-xs"
                      aria-label="移除一个测试人机"
                      disabled={botCount === 0 || isPending?.("song.test.removeBot")}
                      loading={isPending?.("song.test.removeBot")}
                      onClick={() => void run("song.test.removeBot", { count: 1 })}
                    >
                      <Minus className="h-3 w-3" />
                      减一个
                    </Button>
                    <span className="w-10 text-center text-sm font-medium tabular-nums">
                      {botCount}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 flex-1 gap-1 text-xs"
                      aria-label="添加一个测试人机"
                      disabled={isPending?.("song.test.addBot")}
                      loading={isPending?.("song.test.addBot")}
                      onClick={() => void run("song.test.addBot", { count: 1 })}
                    >
                      <Plus className="h-3 w-3" />
                      加一个
                    </Button>
                  </div>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  );
}
