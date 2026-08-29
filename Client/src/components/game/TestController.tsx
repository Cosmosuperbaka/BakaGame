import { useCallback, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronUp, FlaskConical, UserCog, Eye, Shield, Bot, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGameStore } from "@/stores/useGameStore";
import { PHASE_LABELS, ROLE_LABELS } from "@/lib/helpers";
import { collapsible, headerTappable, spring } from "@/lib/motion";
import type { GamePhase, PlayerRole } from "@/types";

/** 观察视角。测试房间通过真实的旁观/出题人指令切换，不再本地伪造。 */
type TestPerspective = "player" | "questioner" | "spectator";

const PHASES: GamePhase[] = [
  "waiting",
  "assigningQuestioner",
  "wordSubmission",
  "description",
  "voting",
  "tieBreak",
  "night",
  "blankGuess",
  "gameOver",
];

const ROLES: PlayerRole[] = ["civilian", "undercover", "angel", "blank"];

export function TestController() {
  const [open, setOpen] = useState(true);

  const snapshot = useGameStore((s) => s.snapshot);
  const privateState = useGameStore((s) => s.privateState);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const currentPhase = snapshot?.status.phase;

  // 所有控制都走真实指令，失败就报错，不再退回本地伪造状态：
  // 测试房间的意义就是复现服务端规则。
  const run = useCallback(
    async (type: string, payload?: Record<string, unknown>) => {
      try {
        await sendCommand(type, payload);
      } catch (error) {
        addToast((error as { message?: string }).message ?? "操作失败", "error");
      }
    },
    [addToast, sendCommand],
  );

  const handleJumpPhase = useCallback(
    (phase: GamePhase) => run("test.jumpToPhase", { phase }),
    [run],
  );

  const handleSetRole = useCallback(
    (role: PlayerRole) => run("test.setMyRole", { role }),
    [run],
  );

  const me = snapshot?.players.find((player) => player.id === privateState?.playerId);
  const botCount = snapshot?.players.filter((player) => player.isBot).length ?? 0;

  const currentPerspective: TestPerspective = privateState?.isQuestioner
    ? "questioner"
    : me?.membership === "spectator"
      ? "spectator"
      : "player";

  /**
   * 视角切换用真实指令表达：
   * 旁观走 player.setSpectator，出题人走 game.assignQuestioner。
   * 两者都只能在对应阶段生效，失败时给出服务端的原因。
   */
  const handleSetPerspective = useCallback(
    async (perspective: TestPerspective) => {
      if (perspective === "questioner") {
        if (!privateState) return;
        await run("game.assignQuestioner", { playerId: privateState.playerId });
        return;
      }
      await run("player.setSpectator", { spectator: perspective === "spectator" });
    },
    [privateState, run],
  );

  const activeRole = privateState?.role;

  return (
    <div className="absolute bottom-3 right-3 left-3 md:left-auto md:right-5 md:bottom-5 z-30 pointer-events-none">
      <div className="flex justify-end pointer-events-auto">
        <motion.div
          layout
          transition={spring.settle}
          className="w-full max-w-full overflow-hidden rounded-xl border bg-background/95 shadow-xl backdrop-blur-md md:w-96"
        >
          <motion.button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            {...headerTappable}
            className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-muted/40"
          >
            <FlaskConical className="h-4 w-4 text-primary" />
            <span>阶段控制器</span>
            <motion.span
              aria-hidden="true"
              className="ml-auto inline-flex text-muted-foreground"
              animate={{ rotate: open ? 0 : 180 }}
              transition={spring.snap}
            >
              <ChevronUp className="h-4 w-4" />
            </motion.span>
          </motion.button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div
                variants={collapsible}
                initial="initial"
                animate="animate"
                exit="exit"
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

                  <ControlGroup
                    label="测试人机"
                    icon={<Bot className="h-3.5 w-3.5 text-sky-500" />}
                  >
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 flex-1 gap-1 text-xs"
                        aria-label="移除一个测试人机"
                        disabled={botCount === 0}
                        onClick={() => run("test.removeBot", { count: 1 })}
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
                        onClick={() => run("test.addBot", { count: 1 })}
                      >
                        <Plus className="h-3 w-3" />
                        加一个
                      </Button>
                    </div>
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
