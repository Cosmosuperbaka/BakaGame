import { useCallback } from "react";
import { Bot, Eye, ListOrdered, Shield, UserCog, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { BotCountRow, TestControllerShell } from "@/components/common/room/TestControllerShell";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { errorText } from "@/lib/ErrorMessage";
import { PHASE_LABELS, ROLE_LABELS } from "@/config/WhoIsFakerPresentation";
import type {
  WhoIsFakerCommand,
  WhoIsFakerPayload,
  WhoIsFakerPhase,
  WhoIsFakerRole,
} from "@bakagame/shared";

/** 观察视角。测试房间通过真实的旁观/出题人指令切换，不再本地伪造。 */
type TestPerspective = "player" | "questioner" | "spectator";

const PHASES: WhoIsFakerPhase[] = [
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

const ROLES: WhoIsFakerRole[] = ["civilian", "undercover", "angel", "blank"];

export function FakerTestController() {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot);
  const privateState = useWhoIsFakerStore((s) => s.privateState);
  const sendCommand = useWhoIsFakerStore((s) => s.sendCommand);
  const showToast = useWhoIsFakerStore((s) => s.showToast);
  const currentPhase = snapshot?.status.phase;

  // 所有控制都走真实指令，失败就报错，不再退回本地伪造状态：
  // 测试房间的意义就是复现服务端规则。
  const run = useCallback(
    async <TCommand extends WhoIsFakerCommand>(
      type: TCommand,
      payload?: WhoIsFakerPayload<TCommand>
    ) => {
      try {
        await sendCommand(type, payload);
      } catch (error) {
        showToast(errorText(error, "操作失败"), "error");
      }
    },
    [showToast, sendCommand]
  );

  const handleJumpPhase = useCallback(
    (phase: WhoIsFakerPhase) => run("test.jumpToPhase", { phase }),
    [run]
  );

  const handleSetRole = useCallback(
    (role: WhoIsFakerRole) => run("test.setMyRole", { role }),
    [run]
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
    [privateState, run]
  );

  const activeRole = privateState?.debugRole;

  return (
    <div className="absolute bottom-3 right-3 left-3 md:left-auto md:right-5 md:bottom-5 z-drawer pointer-events-none">
      <div className="flex justify-end pointer-events-auto">
        <TestControllerShell
          title="阶段控制器"
          bodyClassName="px-4 pb-4 pt-1 space-y-3"
          headerFocusInset
        >
          <ControlGroup label="跳转游戏阶段" icon={ListOrdered}>
            <div className="grid grid-cols-2 gap-1.5">
              {PHASES.map((p) => (
                <Button
                  key={p}
                  variant={currentPhase === p ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs justify-start"
                  onClick={() => void handleJumpPhase(p)}
                >
                  {PHASE_LABELS[p]}
                </Button>
              ))}
            </div>
          </ControlGroup>

          <ControlGroup label="切换观察视角" icon={Eye}>
            <div className="grid grid-cols-3 gap-1.5">
              <Button
                variant={currentPerspective === "player" ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => void handleSetPerspective("player")}
              >
                玩家视角
              </Button>
              <Button
                variant={currentPerspective === "questioner" ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={() => void handleSetPerspective("questioner")}
              >
                <Shield className="h-3 w-3" />
                出题人
              </Button>
              <Button
                variant={currentPerspective === "spectator" ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => void handleSetPerspective("spectator")}
              >
                旁观视角
              </Button>
            </div>
          </ControlGroup>

          {currentPerspective === "player" && (
            <ControlGroup label="切换玩家身份" icon={UserCog}>
              <div className="grid grid-cols-4 gap-1.5">
                {ROLES.map((r) => (
                  <Button
                    key={r}
                    variant={activeRole === r ? "default" : "outline"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => void handleSetRole(r)}
                  >
                    {ROLE_LABELS[r]}
                  </Button>
                ))}
              </div>
            </ControlGroup>
          )}

          <ControlGroup label="测试人机" icon={Bot}>
            <BotCountRow
              count={botCount}
              addPending={false}
              removePending={false}
              onAdd={() => void run("test.addBot", { count: 1 })}
              onRemove={() => void run("test.removeBot", { count: 1 })}
            />
          </ControlGroup>
        </TestControllerShell>
      </div>
    </div>
  );
}

/**
 * 控制器里的一组按钮。组标题取全站区块小标题的口径（标题标签、xs 半粗、弱化色，图标 3.5 与文字同色）：
 * 图标只是组的记号，不按氛围着色；选中按钮是主色实底，按钮里的图标随文字取前景色。
 */
function ControlGroup({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </h3>
      {children}
    </section>
  );
}
