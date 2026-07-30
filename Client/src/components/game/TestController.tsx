import { useCallback, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronUp, FlaskConical, UserCog, Eye, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGameStore } from "@/stores/useGameStore";
import { PHASE_LABELS, ROLE_LABELS } from "@/lib/helpers";
import { cn } from "@/lib/utils";
import type { GamePhase, PlayerRole } from "@/types";
import type { TestPerspective } from "@/lib/mockData";

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

export function TestController() {
  const [open, setOpen] = useState(true);

  const snapshot = useGameStore((s) => s.snapshot);
  const privateState = useGameStore((s) => s.privateState);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const currentPhase = snapshot?.status.phase;

  const testRole = useGameStore((s) => s.testRole);

  const isConnected = useGameStore((s) => s.connected);

  const handleJumpPhase = useCallback(
    async (phase: GamePhase) => {
      if (!isConnected || snapshot?.roomId === "Oblivionis") {
        useGameStore.getState().jumpTestRoomPhase(phase);
        return;
      }
      try {
        await sendCommand("test.jumpToPhase", { phase });
      } catch {
        useGameStore.getState().jumpTestRoomPhase(phase);
      }
    },
    [isConnected, snapshot?.roomId, sendCommand]
  );

  const handleSetPerspective = useCallback(
    (perspective: TestPerspective) => {
      useGameStore.getState().setTestRoomPerspective(perspective);
    },
    []
  );

  const handleSetRole = useCallback(
    async (role: PlayerRole) => {
      if (!isConnected || snapshot?.roomId === "Oblivionis") {
        useGameStore.getState().setTestRoomPerspective("player", role);
        return;
      }
      try {
        await sendCommand("test.setMyRole", { role });
      } catch {
        useGameStore.getState().setTestRoomPerspective("player", role);
      }
    },
    [isConnected, snapshot?.roomId, sendCommand]
  );

  const currentPerspective: TestPerspective = privateState?.questionerView
    ? privateState.isQuestioner
      ? "questioner"
      : "spectator"
    : "player";

  const activeRole = privateState?.role ?? testRole;

  return (
    <div className="absolute bottom-3 right-3 left-3 md:left-auto md:right-5 md:bottom-5 z-30 pointer-events-none">
      <div className="flex justify-end pointer-events-auto">
        <motion.div
          layout
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="rounded-xl border bg-background/95 backdrop-blur-md shadow-xl overflow-hidden w-full md:w-96 max-w-full"
        >
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium hover:bg-muted/40 transition-colors"
          >
            <FlaskConical className="h-4 w-4 text-primary" />
            <span>离线测试控制器</span>
            <span className="text-[11px] text-muted-foreground font-normal ml-auto">
              测试房间
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
                  <ControlGroup label="跳转游戏阶段">
                    <div className="grid grid-cols-2 gap-1.5">
                      {PHASES.map((p) => (
                        <Button
                          key={p}
                          variant={currentPhase === p ? "default" : "outline"}
                          size="sm"
                          className="h-7 text-xs justify-start"
                          onClick={() => handleJumpPhase(p)}
                        >
                          {PHASE_LABELS[p]}
                        </Button>
                      ))}
                    </div>
                  </ControlGroup>

                  <ControlGroup label="切换观察视角" icon={<Eye className="h-3.5 w-3.5 text-blue-500" />}>
                    <div className="grid grid-cols-3 gap-1.5">
                      <Button
                        variant={currentPerspective === "player" ? "default" : "outline"}
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handleSetPerspective("player")}
                      >
                        玩家视角
                      </Button>
                      <Button
                        variant={currentPerspective === "questioner" ? "default" : "outline"}
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => handleSetPerspective("questioner")}
                      >
                        <Shield className="h-3 w-3 text-purple-400" />
                        出题人
                      </Button>
                      <Button
                        variant={currentPerspective === "spectator" ? "default" : "outline"}
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handleSetPerspective("spectator")}
                      >
                        旁观视角
                      </Button>
                    </div>
                  </ControlGroup>

                  {currentPerspective === "player" && (
                    <ControlGroup label="切换玩家身份" icon={<UserCog className="h-3.5 w-3.5 text-emerald-500" />}>
                      <div className="grid grid-cols-4 gap-1.5">
                        {ROLES.map((r) => (
                          <Button
                            key={r}
                            variant={activeRole === r ? "default" : "outline"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => handleSetRole(r)}
                          >
                            {ROLE_LABELS[r]}
                          </Button>
                        ))}
                      </div>
                    </ControlGroup>
                  )}
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
