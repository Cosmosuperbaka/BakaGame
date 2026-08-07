import { useCallback, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { duration, ease, listContainer, spring } from "@/lib/motion";
import {
  FastForward,
  MessageSquarePlus,
  MessageSquareText,
  Scale,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DisconnectHandler } from "@/components/game/DisconnectHandler";
import { PendingSpeech } from "@/components/game/PendingSpeech";
import { PhaseHeader } from "@/components/game/PhaseHeader";
import { SupplementRequestControl } from "@/components/game/SupplementRequestControl";
import { useGameStore } from "@/stores/useGameStore";
import { cn } from "@/lib/utils";
import type { PublicPlayerView, SpeechMode } from "@/types";

const speechMeta = {
  normal: { title: "描述阶段", icon: MessageSquareText, tone: "text-foreground" },
  supplement: { title: "补充发言", icon: MessageSquarePlus, tone: "text-sky-600" },
  tieBreak: { title: "平票 PK", icon: Scale, tone: "text-amber-600" },
} satisfies Record<SpeechMode, { title: string; icon: typeof MessageSquareText; tone: string }>;

/** 发言表格中的一行 */
interface SpeechRow {
  player: PublicPlayerView;
  /** 已提交且顺序已到，可以公开 */
  text?: string;
  /** 本人本轮发言，用于高亮自己那一行 */
  isMe: boolean;
}

/** 发言内容进出：沿文字基线展开，避免与相邻行一起纵向平移 */
const revealSpeech = {
  initial: { opacity: 0, y: 6, filter: "blur(2px)" },
  animate: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { ...spring.swift, filter: { duration: duration.base, ease: ease.out } },
  },
  exit: { opacity: 0, transition: { duration: duration.instant } },
};

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

  /**
   * 本轮应当发言的玩家顺序。
   * 普通轮用服务端下发的 descriptionOrder；PK 与补充发言用各自的候选名单，
   * 并按已提交记录的先后补齐顺序，保证顺序稳定。
   */
  const speechOrder = useMemo<string[]>(() => {
    if (mode === "supplement") {
      const pending = snapshot.status.pendingSupplementPlayerIds ?? [];
      const spoken = currentDescriptions.map((description) => description.playerId);
      return [...new Set([...spoken, ...pending])];
    }
    if (mode === "tieBreak") {
      return snapshot.status.tieBreakCandidateIds ?? [];
    }
    const order = snapshot.status.descriptionOrder ?? [];
    if (order.length > 0) return order;
    // 顺序缺失时退回为存活玩家，避免表格为空。
    return snapshot.players
      .filter(
        (player) =>
          player.roundStatus === "alive" && player.id !== snapshot.status.questionerPlayerId,
      )
      .map((player) => player.id);
  }, [mode, snapshot.status, snapshot.players, currentDescriptions]);

  /**
   * 逐行构建表格。发言按顺序揭示：只要前面还有人没提交，
   * 后面已提交的内容也先不公开，避免抢跑影响其他玩家判断。
   * 出题人与旁观者看到全部内容，本人始终能看到自己那一句。
   */
  const speechRows = useMemo<SpeechRow[]>(() => {
    const textByPlayer = new Map(
      currentDescriptions.map((description) => [description.playerId, description.text]),
    );
    const seesAll = isQuestioner || me?.membership === "spectator";
    let blocked = false;

    return speechOrder.map((playerId) => {
      const player =
        snapshot.players.find((candidate) => candidate.id === playerId) ??
        ({
          id: playerId,
          name: currentDescriptions.find((d) => d.playerId === playerId)?.playerName ?? "已离场",
          score: 0,
          membership: "active",
          online: false,
          isReady: false,
          isBot: false,
          isHost: false,
          roundStatus: "waiting",
        } satisfies PublicPlayerView);

      const text = textByPlayer.get(playerId);
      const isMe = playerId === myId;
      // 顺序一旦断开，后续行即便已提交也保持折起。
      const visible = text !== undefined && (seesAll || isMe || !blocked);
      if (text === undefined) blocked = true;

      return { player, text: visible ? text : undefined, isMe };
    });
  }, [speechOrder, currentDescriptions, snapshot.players, isQuestioner, me?.membership, myId]);
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

      {mode === "supplement" && waitingPlayerIds.includes(myId) ? (
        <div className="flex items-center justify-center gap-2 rounded-md bg-sky-500/10 px-4 py-2.5 text-sky-700 dark:text-sky-300">
          <MessageSquarePlus className="h-4 w-4 shrink-0" />
          <span className="text-sm font-medium">轮到你补充发言</span>
        </div>
      ) : null}

      <SpeechTable rows={speechRows} />

      {canSpeak ? (
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Input
              value={text}
              onChange={(e) => setText(clampToLimit(e.target.value))}
              placeholder={mode === "supplement" ? "输入补充发言..." : "输入你的描述..."}
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
      ) : null}

      {isQuestioner && mode !== "supplement" ? (
        <div className="flex items-center justify-center gap-3 pt-2">
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

/**
 * 本轮发言表：一列玩家名、一列发言内容。
 * 所有应发言玩家默认全部列出，未公开的内容以省略号占位，
 * 行高固定，内容揭示时不引起相邻行位移。
 */
function SpeechTable({ rows }: { rows: SpeechRow[] }) {
  if (rows.length === 0) return null;

  return (
    <motion.table
      className="w-full table-fixed border-collapse text-left text-sm"
      variants={listContainer(rows.length)}
      initial="initial"
      animate="animate"
    >
      <colgroup>
        <col className="w-32 sm:w-40" />
        <col />
      </colgroup>
      <thead>
        <tr className="text-xs font-semibold text-muted-foreground">
          <th scope="col" className="border-b px-3 py-2 font-semibold">
            玩家
          </th>
          <th scope="col" className="border-b px-3 py-2 font-semibold">
            描述
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ player, text, isMe }) => (
          <tr
            key={player.id}
            className={cn("border-b border-border/60 align-top", isMe && "bg-primary/5")}
          >
            <th
              scope="row"
              className={cn(
                "truncate px-3 py-2.5 text-left text-sm font-medium",
                isMe && "text-primary",
              )}
            >
              {player.name}
            </th>
            <td className="px-3 py-2.5 text-sm leading-relaxed">
              {/* 内容与占位互斥切换，用 mode="wait" 保证省略号先退再进 */}
              <AnimatePresence mode="wait" initial={false}>
                {text !== undefined ? (
                  <motion.span
                    key="text"
                    variants={revealSpeech}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className="block break-words"
                  >
                    {text}
                  </motion.span>
                ) : (
                  <motion.span
                    key="pending"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: { duration: duration.instant } }}
                    className="block"
                  >
                    <PendingSpeech />
                  </motion.span>
                )}
              </AnimatePresence>
            </td>
          </tr>
        ))}
      </tbody>
    </motion.table>
  );
}
