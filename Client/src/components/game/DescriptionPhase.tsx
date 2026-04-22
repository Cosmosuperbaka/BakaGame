import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, FastForward, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useGame } from "@/contexts/GameContext";
import { DisconnectHandler } from "@/components/game/DisconnectHandler";

export function DescriptionPhase() {
  const { state, sendCommand, addToast } = useGame();
  const snapshot = state.snapshot!;
  const privateState = state.privateState;
  const phase = snapshot.status.phase;
  const isQuestioner = privateState?.isQuestioner ?? false;
  const me = snapshot.players.find((p) => p.id === privateState?.playerId);

  const [text, setText] = useState("");

  const currentCycleDescriptions = snapshot.descriptions;

  const amAlive = me?.roundStatus === "alive";
  const canDescribe =
    !isQuestioner &&
    amAlive &&
    (phase === "description" || phase === "tieBreak" || phase === "daybreak");

  const tieBreakStage = snapshot.status.tieBreakStage;

  const handleSubmit = useCallback(async () => {
    if (!text.trim()) return;
    try {
      await sendCommand("game.submitDescription", { text: text.trim() });
      setText("");
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [text, sendCommand, addToast]);

  const handleAdvance = useCallback(async () => {
    try {
      await sendCommand("game.advancePhase");
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [sendCommand, addToast]);

  const canGuessBlank = privateState?.canSubmitBlankGuess && !privateState?.blankGuessUsed;

  return (
    <div className="space-y-5 max-w-2xl mx-auto">
      {snapshot.status.pendingDisconnectPlayerId && <DisconnectHandler />}

      <div className="text-center">
        <h2 className="text-2xl font-semibold">
          {phase === "tieBreak"
            ? `平票PK - ${tieBreakStage === "description" ? "补充描述" : "投票"}`
            : phase === "daybreak"
              ? "天亮了"
              : "描述阶段"}
        </h2>
        <p className="text-base text-muted-foreground mt-1">
          {phase === "daybreak"
            ? "夜晚结果已公布，进入新的一天"
            : "请描述你的词语（不要直接说出词语）"}
        </p>
      </div>

      {/* 描述列表 */}
      <div className="space-y-2.5">
        <AnimatePresence>
          {currentCycleDescriptions.map((d) => (
            <motion.div
              key={d.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="flex items-start gap-3 p-3.5 rounded-lg bg-muted/40 border border-transparent hover:border-border/50 transition-colors"
            >
              <MessageSquare className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{d.playerName}</span>
                  {d.kind === "tieBreak" && (
                    <Badge variant="secondary" className="text-xs py-0">PK</Badge>
                  )}
                </div>
                <p className="text-sm text-foreground/85 mt-1">{d.text}</p>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {canDescribe && (
        <div className="flex gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="输入你的描述..."
            className="flex-1 h-10"
            maxLength={100}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          />
          <Button onClick={handleSubmit} className="gap-2 h-10" disabled={!text.trim()}>
            <Send className="h-4 w-4" /> 发送
          </Button>
        </div>
      )}

      {canGuessBlank && (
        <div className="text-center">
          <Button variant="outline" onClick={() => addToast("白板可以在被淘汰时被动猜词", "info")}>
            主动猜词（仅一次机会）
          </Button>
        </div>
      )}

      {isQuestioner && (
        <div className="text-center pt-2">
          <Button onClick={handleAdvance} size="lg" className="gap-2">
            <FastForward className="h-4 w-4" />
            {phase === "description" || phase === "daybreak" ? "进入投票阶段" : "推进游戏"}
          </Button>
        </div>
      )}
    </div>
  );
}
