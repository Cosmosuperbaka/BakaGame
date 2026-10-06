import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Clock, UserX } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { dropIn } from "@/lib/Motion";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { usePhaseAction } from "../phases/UsePhaseAction";

/**
 * 掉线待决：服务端在描述、投票、夜晚与白板猜词等阶段都可能挂起一名阻塞流程的离线玩家，
 * 因此挂在游戏区的阶段之上（`PhaseStage` 的 `before`），不随阶段切换卸载。
 * 主持人选择等待重连或淘汰；其余人只看到说明。
 */
export function DisconnectHandler() {
  const snapshot = useWhoIsFakerStore((s) => s.snapshot);
  const isQuestioner = useWhoIsFakerStore((s) => s.privateState?.isQuestioner ?? false);
  const sendCommand = useWhoIsFakerStore((s) => s.sendCommand);
  const addToast = useWhoIsFakerStore((s) => s.addToast);
  // 两个决定互斥，共用一把锁：等应答期间另一个按钮同样不可点。
  const { run, busy } = usePhaseAction();
  // 记下按下的是哪一个，加载指示只落在它身上。
  const [choice, setChoice] = useState<"wait" | "eliminate" | null>(null);
  const pendingId = snapshot?.status.pendingDisconnectPlayerId;
  const pendingPlayer = snapshot?.players.find((p) => p.id === pendingId);

  const handleResolve = useCallback(
    (resolution: "wait" | "eliminate") =>
      run(async () => {
        if (!pendingId) return;
        setChoice(resolution);
        try {
          await sendCommand("game.resolveDisconnect", { playerId: pendingId, resolution });
        } catch (e) {
          addToast((e as { message: string }).message, "error");
        } finally {
          setChoice(null);
        }
      }),
    [run, pendingId, sendCommand, addToast],
  );

  return (
    <AnimatePresence initial={false}>
      {pendingId && pendingPlayer ? (
        <motion.div
          key={pendingId}
          variants={dropIn}
          initial="initial"
          animate="animate"
          exit="exit"
          role="status"
          className="mx-auto mb-6 max-w-2xl space-y-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-3"
        >
          <p className="flex items-center gap-2 text-sm font-semibold text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">玩家 {pendingPlayer.name} 已掉线</span>
          </p>
          {isQuestioner ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} loading={choice === "wait"} onClick={() => void handleResolve("wait")}>
                <Clock className="h-3.5 w-3.5" />
                等待重连
              </Button>
              <Button size="sm" variant="destructive" disabled={busy} loading={choice === "eliminate"} onClick={() => void handleResolve("eliminate")}>
                <UserX className="h-3.5 w-3.5" />
                淘汰并踢出
              </Button>
            </div>
          ) : (
            <p className="text-xs text-warning">等待主持人处理</p>
          )}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
