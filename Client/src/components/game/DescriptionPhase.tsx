import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, FastForward, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useGame } from "@/contexts/GameContext";
import { DisconnectHandler } from "@/components/game/DisconnectHandler";

// 字符宽度计数：CJK 及全角字符算 2 个单位，其余算 1 个单位。上限 20 单位（≈10 中文/20 英文）。
const DESCRIPTION_MAX_UNITS = 20;

const getCharUnits = (char: string): number => {
  const code = char.codePointAt(0) ?? 0;
  // CJK 统一汉字、扩展区、全角标点、Katakana/Hiragana 等宽字符
  if (
    (code >= 0x1100 && code <= 0x115f) ||  // Hangul Jamo
    (code >= 0x2e80 && code <= 0x9fff) ||  // CJK、部首、康熙等
    (code >= 0xa960 && code <= 0xa97f) ||  // Hangul Jamo Extended
    (code >= 0xac00 && code <= 0xd7ff) ||  // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) ||  // CJK Compatibility
    (code >= 0xfe10 && code <= 0xfe1f) ||  // Vertical Forms
    (code >= 0xfe30 && code <= 0xfe6f) ||  // CJK Compatibility Forms
    (code >= 0xff01 && code <= 0xff60) ||  // Fullwidth Forms
    (code >= 0xffe0 && code <= 0xffe6) ||  // Fullwidth Signs
    (code >= 0x1b000 && code <= 0x1b0ff) || // Kana Supplement
    (code >= 0x20000 && code <= 0x2fffd) || // CJK Unified Ideographs Extension B-F
    (code >= 0x30000 && code <= 0x3fffd)    // CJK Unified Ideographs Extension G
  ) {
    return 2;
  }
  return 1;
};

const countTextUnits = (text: string): number =>
  [...text].reduce((sum, ch) => sum + getCharUnits(ch), 0);

const clampToLimit = (text: string): string => {
  let units = 0;
  let result = "";
  for (const ch of text) {
    const w = getCharUnits(ch);
    if (units + w > DESCRIPTION_MAX_UNITS) break;
    units += w;
    result += ch;
  }
  return result;
};

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
          <div className="flex-1 relative">
            <Input
              value={text}
              onChange={(e) => setText(clampToLimit(e.target.value))}
              placeholder="输入你的描述..."
              className="flex-1 h-10 pr-14"
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none tabular-nums">
              {countTextUnits(text)}/{DESCRIPTION_MAX_UNITS}
            </span>
          </div>
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
