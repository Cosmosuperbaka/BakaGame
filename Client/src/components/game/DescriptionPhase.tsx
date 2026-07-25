import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, FastForward, MessageSquare, HelpCircle } from "lucide-react";
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
  const [showBlankModal, setShowBlankModal] = useState(false);

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
    <div className="space-y-6 max-w-2xl mx-auto">
      {snapshot.status.pendingDisconnectPlayerId && <DisconnectHandler />}

      <div className="text-center">
        <h2 className="text-2xl font-semibold">
          {phase === "tieBreak"
            ? `平票 PK - ${tieBreakStage === "description" ? "补充描述" : "投票"}`
            : phase === "daybreak"
              ? "天亮了"
              : "描述阶段"}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {phase === "daybreak"
            ? "夜晚结果已公布，进入新的一天"
            : "请描述你的词语（不要直接说出词语）"}
        </p>
      </div>

      {/* 描述列表 - 独立高对比度卡片 */}
      <div className="space-y-3">
        <AnimatePresence>
          {currentCycleDescriptions.map((d) => (
            <motion.div
              key={d.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="flex items-start gap-3.5 p-4 rounded-xl bg-card border border-border/80 shadow-2xs text-foreground"
            >
              <div className="p-2 rounded-lg bg-primary/10 text-primary mt-0.5 shrink-0">
                <MessageSquare className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{d.playerName}</span>
                  {d.kind === "tieBreak" && (
                    <Badge variant="outline" className="text-xs py-0 border-amber-500/40 text-amber-600">
                      PK发言
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-foreground/90 leading-relaxed mt-1.5 break-words font-normal">
                  {d.text}
                </p>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* 发送框与固定位置的白板猜词按钮 */}
      {canDescribe && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="输入你的描述..."
              className="flex-1 h-10"
              maxLength={100}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
            <Button onClick={handleSubmit} className="gap-2 h-10 px-5" disabled={!text.trim()}>
              <Send className="h-4 w-4" /> 发送
            </Button>
          </div>

          {canGuessBlank && (
            <div className="flex justify-end pt-1">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => setShowBlankModal((v) => !v)}
              >
                <HelpCircle className="h-3.5 w-3.5 text-amber-500" />
                主动猜词
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 白板猜词弹层 */}
      {showBlankModal && canGuessBlank && (
        <div className="p-4 rounded-xl border bg-card shadow-md space-y-3">
          <div className="text-xs font-semibold text-muted-foreground">白板主动猜词</div>
          <BlankGuessForm onClose={() => setShowBlankModal(false)} />
        </div>
      )}

      {isQuestioner && (
        <div className="text-center pt-2">
          <Button onClick={handleAdvance} size="lg" className="gap-2 px-6">
            <FastForward className="h-4 w-4" />
            {phase === "description" || phase === "daybreak" ? "进入投票阶段" : "推进游戏"}
          </Button>
        </div>
      )}
    </div>
  );
}

function BlankGuessForm({ onClose }: { onClose: () => void }) {
  const { sendCommand, addToast } = useGame();
  const [wordA, setWordA] = useState("");
  const [wordB, setWordB] = useState("");

  const handleSubmit = useCallback(async () => {
    if (!wordA.trim() || !wordB.trim()) {
      addToast("请输入两个词语", "error");
      return;
    }
    try {
      await sendCommand("game.submitBlankGuess", { words: [wordA.trim(), wordB.trim()] });
      onClose();
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [wordA, wordB, sendCommand, addToast, onClose]);

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <Input
          value={wordA}
          onChange={(e) => setWordA(e.target.value)}
          placeholder="平民词语"
          className="h-9 text-xs"
        />
        <Input
          value={wordB}
          onChange={(e) => setWordB(e.target.value)}
          placeholder="卧底词语"
          className="h-9 text-xs"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} className="h-8 text-xs">
          取消
        </Button>
        <Button size="sm" onClick={handleSubmit} className="h-8 text-xs gap-1.5">
          <Send className="h-3.5 w-3.5" /> 提交
        </Button>
      </div>
    </div>
  );
}
