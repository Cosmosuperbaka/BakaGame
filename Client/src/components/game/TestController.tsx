import { useCallback, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronUp, FlaskConical, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGame } from "@/contexts/GameContext";
import { PHASE_LABELS, ROLE_LABELS } from "@/lib/helpers";
import { cn } from "@/lib/utils";
import type { GamePhase, PlayerRole } from "@/types";

const PHASES: GamePhase[] = [
  "waiting",
  "assigningQuestioner",
  "wordSubmission",
  "description",
  "voting",
  "tieBreak",
  "night",
  "daybreak",
  "blankGuess",
  "gameOver",
];

const ROLES: PlayerRole[] = ["civilian", "undercover", "angel", "blank"];

// 仅在测试房间显示；提供"跳转阶段"和"切换身份"两组按钮。
export function TestController() {
  const { state, sendCommand, addToast } = useGame();
  const [open, setOpen] = useState(true);
  const snapshot = state.snapshot;
  const privateState = state.privateState;

  const currentPhase = snapshot?.status.phase;
  const myRole = privateState?.role;

  const jumpToPhase = useCallback(
    async (phase: GamePhase) => {
      try {
        await sendCommand("test.jumpToPhase", { phase });
      } catch (e) {
        addToast((e as { message: string }).message, "error");
      }
    },
    [sendCommand, addToast]
  );

  const setMyRole = useCallback(
    async (role: PlayerRole) => {
      try {
        await sendCommand("test.setMyRole", { role });
      } catch (e) {
        addToast((e as { message: string }).message, "error");
      }
    },
    [sendCommand, addToast]
  );

  return (
    <div className="absolute bottom-3 right-3 left-3 md:left-auto md:right-5 md:bottom-5 z-10 pointer-events-none">
      <div className="flex justify-end pointer-events-auto">
        <motion.div
          layout
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="rounded-xl border bg-background/95 backdrop-blur-sm shadow-lg overflow-hidden w-full md:w-96 max-w-full"
        >
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-4 py-2 text-sm font-medium hover:bg-muted/40 transition-colors"
          >
            <FlaskConical className="h-4 w-4 text-primary" />
            <span>测试控制器</span>
            <span className="text-xs text-muted-foreground font-normal ml-auto">
              仅在 Oblivionis 房间可见
            </span>
            <ChevronUp
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform duration-200",
                !open && "rotate-180"
              )}
            />
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <div className="px-4 pb-4 pt-1 space-y-3">
                  <ControlGroup label="跳转到阶段">
                    <div className="grid grid-cols-2 gap-1.5">
                      {PHASES.map((p) => (
                        <Button
                          key={p}
                          variant={currentPhase === p ? "default" : "outline"}
                          size="sm"
                          className="h-7 text-xs justify-start"
                          onClick={() => jumpToPhase(p)}
                        >
                          {PHASE_LABELS[p]}
                        </Button>
                      ))}
                    </div>
                  </ControlGroup>

                  <ControlGroup label="切换我的身份" icon={<UserCog className="h-3.5 w-3.5" />}>
                    <div className="grid grid-cols-4 gap-1.5">
                      {ROLES.map((r) => (
                        <Button
                          key={r}
                          variant={myRole === r ? "default" : "outline"}
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setMyRole(r)}
                        >
                          {ROLE_LABELS[r]}
                        </Button>
                      ))}
                    </div>
                    {!privateState || privateState.isQuestioner ? (
                      <p className="text-[11px] text-muted-foreground mt-1.5">
                        {privateState?.isQuestioner
                          ? "出题人不能切换身份"
                          : "尚未进入本局或无分配"}
                      </p>
                    ) : null}
                  </ControlGroup>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  );
}

function ControlGroup({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}
