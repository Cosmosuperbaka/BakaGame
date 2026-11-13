import { useCallback, useId, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { fadeSwap, listContainer, listItem, speechReveal } from "@/lib/Motion";
import { FastForward, MessageSquarePlus, MessageSquareText, Scale, Send } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Hint } from "@/components/ui/Tooltip";
import { FakerPendingSpeech, SubmittedSpeech } from "../layout/FakerPendingSpeech";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { useFakerAutoSubmitOnTimeout } from "./UseFakerAutoSubmitOnTimeout";
import { useFakerPhaseAction } from "./UseFakerPhaseAction";
import { useSupplementRequest } from "../layout/FakerSupplementRequestControl";
import { FAKER_DESCRIPTION_MAX_UNITS, clampUnits, textUnits } from "@bakagame/shared/values";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { cn } from "@/lib/Utils";
import type { SpeechMode, WhoIsFakerRoomSnapshot } from "@bakagame/shared";

const EMPTY_ORDER: readonly string[] = [];

const speechMeta = {
  normal: { title: "描述阶段", icon: MessageSquareText, tone: "text-foreground" },
  supplement: { title: "补充发言", icon: MessageSquarePlus, tone: "text-info" },
  tieBreak: { title: "平票 PK", icon: Scale, tone: "text-warning" },
} satisfies Record<SpeechMode, { title: string; icon: typeof MessageSquareText; tone: string }>;

/** 发言表格中的一行 */
interface SpeechRow {
  player: {
    id: string;
    name: string;
  };
  /** 已提交且顺序已到，可以公开 */
  text?: string;
  /** 已提交但顺序未到，内容仍需折起 */
  submitted: boolean;
  /** 本人本轮发言，用于高亮自己那一行 */
  isMe: boolean;
}

/**
 * 发言模式：普通描述时服务端不下发 speechMode，按阶段回退，PK 阶段的语气仍是 PK。
 * 应发言名单与已提交名单没有回退：描述、补充发言与平票 PK 描述阶段，服务端快照总会下发
 * speechOrder 与 submittedSpeechPlayerIds，它们是「当前这一列」的唯一定义。
 */
const resolveSpeechMode = (status: WhoIsFakerRoomSnapshot["status"]): SpeechMode =>
  status.speechMode ?? (status.phase === "tieBreak" ? "tieBreak" : "normal");

/** 输入框文案随模式切换：补充发言与正常描述用词不同。 */
const speechInputLabel = (mode: SpeechMode) => (mode === "supplement" ? "补充发言" : "描述");
const speechInputPlaceholder = (mode: SpeechMode) =>
  mode === "supplement" ? "输入补充发言..." : "输入你的描述...";

/** 出题人一侧的推进区：补充发言期间只提示还差几人，普通与 PK 阶段给推进按钮。 */
function QuestionerAdvancePanel({
  mode,
  supplement,
  advancing,
  onAdvance,
}: {
  mode: SpeechMode;
  supplement: ReturnType<typeof useSupplementRequest>;
  advancing: boolean;
  onAdvance: () => void;
}) {
  if (mode === "supplement") return supplement.hint;
  return (
    <div className="pt-2">
      {supplement.panel}
      <div className="flex flex-wrap items-center justify-center gap-3">
        {mode === "normal" ? supplement.trigger : null}
        <Button
          onClick={onAdvance}
          size="lg"
          loading={advancing}
          data-agent-control="faker.advance"
        >
          {advancing ? null : <FastForward className="h-4 w-4" />}
          {mode === "normal" ? "进入投票阶段" : "进入 PK 投票"}
        </Button>
      </div>
    </div>
  );
}

export function FakerDescriptionPhase() {
  const snapshot = useWhoIsFakerStore((state) => state.snapshot)!;
  const privateState = useWhoIsFakerStore((state) => state.privateState);
  const [text, setText] = useState("");

  const mode = resolveSpeechMode(snapshot.status);
  const meta = speechMeta[mode];
  const isQuestioner = privateState?.isQuestioner ?? false;
  const me = snapshot.players.find((player) => player.id === privateState?.playerId);
  const amAlive = me?.roundStatus === "alive";

  const currentDescriptions = useMemo(() => {
    if (mode === "tieBreak") {
      return snapshot.descriptions.filter(
        (description) =>
          description.kind === "tieBreak" &&
          description.tieBreakIndex === snapshot.status.tieBreakIndex
      );
    }
    if (mode === "supplement") {
      return snapshot.descriptions.filter(
        (description) =>
          description.kind === "supplement" &&
          description.supplementIndex === snapshot.status.supplementIndex
      );
    }
    return snapshot.descriptions.filter(
      (description) =>
        description.kind === "description" && description.cycle === snapshot.status.day
    );
  }, [
    mode,
    snapshot.descriptions,
    snapshot.status.day,
    snapshot.status.supplementIndex,
    snapshot.status.tieBreakIndex,
  ]);

  const submittedPlayerIds = useMemo(
    () => new Set(snapshot.status.submittedSpeechPlayerIds ?? []),
    [snapshot.status.submittedSpeechPlayerIds]
  );

  const myId = privateState?.playerId ?? "";

  const speechOrder = snapshot.status.speechOrder ?? EMPTY_ORDER;

  const waitingPlayerIds = useMemo(() => {
    return speechOrder.filter((playerId) => !submittedPlayerIds.has(playerId));
  }, [speechOrder, submittedPlayerIds]);

  /**
   * 服务端已经只下发顺序连续完成的公开前缀；客户端不再为任何身份开后门。
   */
  const speechRows = useMemo<SpeechRow[]>(() => {
    const textByPlayer = new Map(
      currentDescriptions.map((description) => [description.playerId, description.text])
    );
    const playerNameById = new Map(snapshot.players.map((player) => [player.id, player.name]));

    return speechOrder.map((playerId) => {
      const name =
        playerNameById.get(playerId) ??
        currentDescriptions.find((d) => d.playerId === playerId)?.playerName ??
        "已离场";
      const text = textByPlayer.get(playerId);
      const isMe = playerId === myId;

      return {
        player: { id: playerId, name },
        text,
        submitted: submittedPlayerIds.has(playerId),
        isMe,
      };
    });
  }, [speechOrder, currentDescriptions, snapshot.players, myId, submittedPlayerIds]);
  const canSpeak =
    amAlive &&
    !isQuestioner &&
    !submittedPlayerIds.has(myId) &&
    (mode === "normal" || waitingPlayerIds.includes(myId));

  // 提交与推进共用一把锁：等应答期间另一个按钮同样不可点
  const { exec, pending } = useFakerPhaseAction();
  const submitting = pending === "game.submitDescription";
  const advancing = pending === "game.advancePhase";

  const handleSubmit = useCallback(() => {
    const normalized = text.trim();
    if (!normalized) return Promise.resolve();
    return exec("game.submitDescription", { text: normalized }, { onSuccess: () => setText("") });
  }, [exec, text]);

  // 阶段倒计时归零时，自动将本地已输入的内容发送提交
  useFakerAutoSubmitOnTimeout({
    enabled: canSpeak && !submitting,
    hasContent: Boolean(text.trim()),
    submit: handleSubmit,
  });

  // 主持人在普通描述里可以发起补充发言；入口在按钮行，选人面板是按钮行上方的整宽块。
  const supplement = useSupplementRequest({
    canRequest: mode === "normal" && waitingPlayerIds.length === 0,
  });
  const counterId = useId();

  const handleAdvance = () => void exec("game.advancePhase");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PhaseHeader icon={meta.icon} title={meta.title} iconClassName={meta.tone} />

      {mode === "supplement" && waitingPlayerIds.includes(myId) ? (
        <div className="flex items-center justify-center gap-2 rounded-md bg-info/10 px-4 py-2.5 text-info">
          <MessageSquarePlus className="h-4 w-4 shrink-0" />
          <span className="text-sm font-medium">轮到你补充发言</span>
        </div>
      ) : null}

      <SpeechTable rows={speechRows} />

      {canSpeak ? (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              value={text}
              aria-label={speechInputLabel(mode)}
              aria-describedby={counterId}
              onChange={(e) => setText(clampUnits(e.target.value, FAKER_DESCRIPTION_MAX_UNITS))}
              placeholder={speechInputPlaceholder(mode)}
              className="h-10 pr-14"
              data-agent-control="faker.description.input"
              // 输入法组字时的回车只是上屏，不当作发送
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void handleSubmit();
              }}
            />
            <span
              id={counterId}
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs tabular-nums text-muted-foreground"
            >
              {textUnits(text)}/{FAKER_DESCRIPTION_MAX_UNITS}
            </span>
          </div>
          <Button
            size="lg"
            onClick={() => void handleSubmit()}
            loading={submitting}
            disabled={!text.trim()}
            data-agent-control="faker.description.send"
            aria-label="发送"
          >
            {/* 手机上只留图标（与聊天发送钮同形），把宽度让给 20 字的输入框 */}
            {submitting ? null : <Send className="h-4 w-4" />}
            <span className="hidden sm:inline">发送</span>
          </Button>
        </div>
      ) : !isQuestioner && me?.membership === "active" && !amAlive ? (
        <p className="text-center text-sm text-muted-foreground">你已出局，本轮不发言</p>
      ) : null}

      {/* 补充发言期间主持人不推进，只看还差几人 */}
      {isQuestioner ? (
        <QuestionerAdvancePanel
          mode={mode}
          supplement={supplement}
          advancing={advancing}
          onAdvance={handleAdvance}
        />
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
        {rows.map(({ player, text, submitted, isMe }) => (
          <motion.tr
            key={player.id}
            variants={listItem}
            className={cn("origin-left border-b border-border align-top", isMe && "bg-primary/5")}
          >
            <Hint label={player.name}>
              <th
                scope="row"
                className={cn(
                  "truncate px-3 py-2.5 text-left text-sm",
                  // 本人那一行已有主色浅底，名字用正文色加粗，主色不作正文
                  isMe ? "font-semibold text-foreground" : "font-medium"
                )}
              >
                {player.name}
              </th>
            </Hint>
            <td className="px-3 py-2.5 text-sm leading-relaxed">
              {/* 内容与占位互斥切换，用 mode="wait" 保证省略号先退再进 */}
              <AnimatePresence mode="wait" initial={false}>
                {text !== undefined ? (
                  <motion.span
                    key="text"
                    variants={speechReveal}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className="block break-words"
                  >
                    {text}
                  </motion.span>
                ) : (
                  <motion.span
                    key={submitted ? "submitted" : "pending"}
                    variants={fadeSwap}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className="block"
                  >
                    {/* 已提交只是还没轮到公开，与「还在等这位玩家」是两种状态 */}
                    {submitted ? <SubmittedSpeech /> : <FakerPendingSpeech />}
                  </motion.span>
                )}
              </AnimatePresence>
            </td>
          </motion.tr>
        ))}
      </tbody>
    </motion.table>
  );
}
