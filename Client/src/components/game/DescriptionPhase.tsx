import { useCallback, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listItem } from "@/lib/motion";
import {
  FastForward,
  MessageSquare,
  MessageSquarePlus,
  MessageSquareText,
  Scale,
  Send,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DisconnectHandler } from "@/components/game/DisconnectHandler";
import { PhaseHeader } from "@/components/game/PhaseHeader";
import { SupplementRequestControl } from "@/components/game/SupplementRequestControl";
import { useGameStore } from "@/stores/useGameStore";
import { cn } from "@/lib/utils";
import type { SpeechMode } from "@/types";

const speechMeta = {
  normal: { title: "描述阶段", icon: MessageSquareText, tone: "text-foreground" },
  supplement: { title: "补充发言", icon: MessageSquarePlus, tone: "text-sky-600" },
  tieBreak: { title: "平票 PK", icon: Scale, tone: "text-amber-600" },
} satisfies Record<SpeechMode, { title: string; icon: typeof MessageSquareText; tone: string }>;

export function DescriptionPhase() {
  const snapshot = useGameStore((state) => state.snapshot)!;
  const privateState = useGameStore((state) => state.privateState);
  const sendCommand = useGameStore((state) => state.sendCommand);
  const addToast = useGameStore((state) => state.addToast);
  const [text, setText] = useState("");

  const phase = snapshot.status.phase;
  const mode: SpeechMode =
    snapshot.status.speechMode ?? (phase === "tieBreak" ? "tieBreak" : "normal");
  const meta = speechMeta[mode];
  const isQuestioner = privateState?.isQuestioner ?? false;
  const me = snapshot.players.find((player) => player.id === privateState?.playerId);
  const amAlive = me?.roundStatus === "alive";

  const currentDescriptions = useMemo(() => {
    if (mode === "tieBreak") {
      return snapshot.descriptions.filter(
        (description) =>
          description.kind === "tieBreak" &&
          description.tieBreakIndex === snapshot.status.tieBreakIndex,
      );
    }
    if (mode === "supplement") {
      return snapshot.descriptions.filter(
        (description) =>
          description.kind === "supplement" &&
          description.supplementIndex === snapshot.status.supplementIndex,
      );
    }
    return snapshot.descriptions.filter(
      (description) =>
        description.kind === "description" && description.cycle === snapshot.status.day,
    );
  }, [
    mode,
    snapshot.descriptions,
    snapshot.status.day,
    snapshot.status.supplementIndex,
    snapshot.status.tieBreakIndex,
  ]);

  const submittedPlayerIds = useMemo(
    () => new Set(currentDescriptions.map((description) => description.playerId)),
    [currentDescriptions],
  );

  const waitingPlayerIds = useMemo(() => {
    if (mode === "supplement") {
      return snapshot.status.pendingSupplementPlayerIds ?? [];
    }
    if (mode === "tieBreak") {
      return (snapshot.status.tieBreakCandidateIds ?? []).filter(
        (playerId) => !submittedPlayerIds.has(playerId),
      );
    }
    return (snapshot.status.descriptionOrder ?? []).filter(
      (playerId) => !submittedPlayerIds.has(playerId),
    );
  }, [mode, snapshot.status, submittedPlayerIds]);

  const waitingPlayers = waitingPlayerIds
    .map((playerId) => snapshot.players.find((player) => player.id === playerId))
    .filter((player): player is (typeof snapshot.players)[number] => player !== undefined);
  const myId = privateState?.playerId ?? "";
  const canSpeak =
    amAlive &&
    !isQuestioner &&
    !submittedPlayerIds.has(myId) &&
    (mode === "normal" || waitingPlayerIds.includes(myId));

  const handleSubmit = useCallback(async () => {
    const normalized = text.trim();
    if (!normalized) return;
    try {
      await sendCommand("game.submitDescription", { text: normalized });
      setText("");
    } catch (error) {
      addToast((error as { message: string }).message, "error");
    }
  }, [addToast, sendCommand, text]);

  const handleAdvance = useCallback(async () => {
    try {
      await sendCommand("game.advancePhase");
    } catch (error) {
      addToast((error as { message: string }).message, "error");
    }
  }, [addToast, sendCommand]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {snapshot.status.pendingDisconnectPlayerId ? <DisconnectHandler /> : null}

      <PhaseHeader icon={meta.icon} title={meta.title} iconClassName={meta.tone} />

      {waitingPlayers.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
          <Users className="h-4 w-4 shrink-0" />
          {waitingPlayers.map((player, index) => (
            <Badge key={player.id} variant="secondary" className="font-normal">
              {index + 1}. {player.name}
            </Badge>
          ))}
        </div>
      ) : null}

      {mode === "supplement" && waitingPlayerIds.includes(myId) ? (
        <div className="flex items-center justify-center gap-2 rounded-md bg-sky-500/10 px-4 py-2.5 text-sky-700 dark:text-sky-300">
          <MessageSquarePlus className="h-4 w-4 shrink-0" />
          <span className="text-sm font-medium">轮到你补充发言</span>
        </div>
      ) : null}

      <div className="space-y-3">
        <AnimatePresence initial={false}>
          {currentDescriptions.map((description) => (
            <motion.div
              key={description.id}
              variants={listItem}
              initial="initial"
              animate="animate"
              exit="exit"
              className="flex items-start gap-3.5 rounded-md bg-muted p-4 text-foreground"
            >
              <div className="mt-0.5 shrink-0 rounded-md bg-background/70 p-2 text-primary">
                <MessageSquare className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{description.playerName}</span>
                  {description.kind !== "description" ? (
                    <span
                      className={cn(
                        "text-xs font-medium",
                        description.kind === "tieBreak" ? "text-amber-700" : "text-sky-700",
                      )}
                    >
                      {description.kind === "tieBreak" ? "PK 发言" : "补充"}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1.5 break-words text-sm leading-relaxed text-foreground/90">
                  {description.text}
                </p>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {canSpeak ? (
        <div className="flex gap-2">
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={mode === "supplement" ? "输入补充发言..." : "输入你的描述..."}
            className="h-10 flex-1"
            maxLength={100}
            onKeyDown={(event) => event.key === "Enter" && handleSubmit()}
          />
          <Button onClick={handleSubmit} className="h-10 gap-2 px-5" disabled={!text.trim()}>
            <Send className="h-4 w-4" />
            发送
          </Button>
        </div>
      ) : null}

      {isQuestioner && mode !== "supplement" ? (
        <div className="space-y-3 pt-2 text-center">
          {mode === "normal" ? (
            <SupplementRequestControl canRequest={waitingPlayers.length === 0} />
          ) : null}
          <Button onClick={handleAdvance} size="lg" className="gap-2 px-6">
            <FastForward className="h-4 w-4" />
            {mode === "normal" ? "进入投票阶段" : "进入 PK 投票"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
