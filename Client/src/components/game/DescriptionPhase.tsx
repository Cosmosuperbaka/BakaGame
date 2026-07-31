import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, FastForward, MessageSquare, Plus, X, Check, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useGameStore } from "@/stores/useGameStore";
import { DisconnectHandler } from "@/components/game/DisconnectHandler";
import { cn } from "@/lib/utils";

export function DescriptionPhase() {
  const snapshot = useGameStore((s) => s.snapshot)!;
  const privateState = useGameStore((s) => s.privateState);
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const phase = snapshot.status.phase;
  const isQuestioner = privateState?.isQuestioner ?? false;
  const me = snapshot.players.find((p) => p.id === privateState?.playerId);

  const [text, setText] = useState("");
  // 补充发言：出题人选择待补充玩家
  const [showSupplementSelector, setShowSupplementSelector] = useState(false);
  const [selectedSupplementIds, setSelectedSupplementIds] = useState<string[]>([]);

  const currentCycleDescriptions =
    phase === "tieBreak"
      ? snapshot.descriptions.filter(
          (description) =>
            description.kind === "tieBreak" &&
            description.tieBreakIndex === snapshot.status.tieBreakIndex,
        )
      : snapshot.descriptions;
  const submittedThisCycle = new Set(
    snapshot.descriptions
      .filter(
        (description) =>
          description.kind === "description" && description.cycle === snapshot.status.day,
      )
      .map((description) => description.playerId),
  );
  const waitingPlayers = (snapshot.status.descriptionOrder ?? [])
    .map((playerId) => snapshot.players.find((player) => player.id === playerId))
    .filter(
      (player): player is (typeof snapshot.players)[number] =>
        player !== undefined &&
        player.roundStatus === "alive" &&
        !submittedThisCycle.has(player.id),
    );

  const amAlive = me?.roundStatus === "alive";

  // pendingSupplementPlayerIds：本玩家是否被要求补充发言
  const pendingSupplementPlayerIds = snapshot.status.pendingSupplementPlayerIds ?? [];
  const isWaitingToSupplement = pendingSupplementPlayerIds.includes(me?.id ?? "");
  const supplementActive = pendingSupplementPlayerIds.length > 0;

  const canDescribe =
    !isQuestioner &&
    amAlive &&
    (phase === "description" || phase === "tieBreak" || phase === "daybreak");

  // 补充发言入口只在描述阶段对出题人开放
  const canRequestSupplement = isQuestioner && phase === "description" && !supplementActive;

  const tieBreakStage = snapshot.status.tieBreakStage;

  // 存活非出题人玩家列表，供出题人选择补充对象
  const aliveCandidates = snapshot.players.filter(
    (p) => p.roundStatus === "alive" && p.id !== me?.id
  );

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

  const handleRequestSupplement = useCallback(async () => {
    if (!selectedSupplementIds.length) {
      addToast("请至少选择一名玩家", "error");
      return;
    }
    try {
      await sendCommand("game.requestSupplement", { playerIds: selectedSupplementIds });
      setShowSupplementSelector(false);
      setSelectedSupplementIds([]);
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  }, [selectedSupplementIds, sendCommand, addToast]);

  const toggleSupplementId = (id: string) => {
    setSelectedSupplementIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

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

      {phase === "description" && waitingPlayers.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-sm text-muted-foreground">
          <Users className="h-4 w-4 shrink-0" />
          <span className="font-medium">待发言：</span>
          {waitingPlayers.map((player, index) => (
            <Badge key={player.id} variant="secondary" className="font-normal">
              {index + 1}. {player.name}
            </Badge>
          ))}
        </div>
      )}

      {/* 被要求补充发言的提示横幅 */}
      {isWaitingToSupplement && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-sky-300/60 bg-sky-500/8 text-sky-800 dark:text-sky-300">
          <MessageSquare className="h-4 w-4 shrink-0" />
          <span className="text-sm font-medium">出题人要求你补充发言，请在下方输入</span>
        </div>
      )}

      {/* 当前描述列表 */}
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
                  {d.kind === "supplement" && (
                    <Badge variant="outline" className="text-xs py-0 border-sky-400/40 text-sky-600">
                      补充
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

      {/* 输入框：普通描述或补充发言 */}
      {(canDescribe || isWaitingToSupplement) && (
        <div className="flex gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={isWaitingToSupplement ? "输入补充发言..." : "输入你的描述..."}
            className={cn("flex-1 h-10", isWaitingToSupplement && "border-sky-400/60 focus-visible:ring-sky-400/40")}
            maxLength={100}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          />
          <Button onClick={handleSubmit} className="gap-2 h-10 px-5" disabled={!text.trim()}>
            <Send className="h-4 w-4" /> 发送
          </Button>
        </div>
      )}

      {/* 出题人操作区 */}
      {isQuestioner && (
        <div className="space-y-3 pt-2 text-center">
          {/* 补充发言请求面板 */}
          <AnimatePresence>
            {showSupplementSelector && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <div className="p-4 rounded-xl border bg-card space-y-3 text-left">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Users className="h-4 w-4 text-sky-500" />
                      请求补充发言
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => {
                        setShowSupplementSelector(false);
                        setSelectedSupplementIds([]);
                      }}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {aliveCandidates.map((p) => {
                      const sel = selectedSupplementIds.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => toggleSupplementId(p.id)}
                          className={cn(
                            "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                            sel
                              ? "bg-sky-500/15 border-sky-400/60 text-sky-700 dark:text-sky-300"
                              : "bg-muted/60 border-border text-muted-foreground hover:bg-muted"
                          )}
                        >
                          {sel && <Check className="h-3 w-3" />}
                          {p.name}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setShowSupplementSelector(false);
                        setSelectedSupplementIds([]);
                      }}
                      className="h-8 text-xs"
                    >
                      取消
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleRequestSupplement}
                      disabled={!selectedSupplementIds.length}
                      className="h-8 text-xs gap-1.5"
                    >
                      <Send className="h-3.5 w-3.5" />
                      发起补充 ({selectedSupplementIds.length})
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 正在进行补充时的状态提示 */}
          {supplementActive && phase === "description" && (
            <p className="text-xs text-sky-600 dark:text-sky-400 text-center">
              等待 {pendingSupplementPlayerIds.length} 名玩家完成补充发言...
            </p>
          )}

          <div className="flex items-center justify-center gap-2">
            {canRequestSupplement && !showSupplementSelector && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => setShowSupplementSelector(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                请求补充发言
              </Button>
            )}
            <Button onClick={handleAdvance} size="lg" className="gap-2 px-6">
              <FastForward className="h-4 w-4" />
              {phase === "description" || phase === "daybreak" ? "进入投票阶段" : "推进游戏"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
