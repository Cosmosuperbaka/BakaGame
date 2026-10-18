import { useState, type ReactNode, type Ref } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Dices, Flag, Image, PenLine, Search, Trophy } from "lucide-react";
import type {
  CEECharacterSummary,
  CEEGuess,
  CEEPlayer,
  CEEPrivateState,
  CEERoomSnapshot,
} from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { CloseButton } from "@/components/ui/CloseButton";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { SearchOptionContent } from "@/components/common/SearchCombobox";
import { CountdownBadge } from "@/components/common/room/CountdownBadge";
import { PhaseStage } from "@/components/common/room/PhaseStage";
import { ScoreTable, type ScoreTableColumn } from "@/components/common/room/ScoreTable";
import { useOriginTracker } from "@/hooks/UseOriginTracker";
import { useCEEAction } from "@/hooks/UseCEEAction";
import type { ReplayRound } from "@/lib/CeeReplay";
import { listItem, readoutSwap, receiptCard, receiptMarkFollow, skeletonFade } from "@/lib/Motion";
import { CEESearch } from "./CEESearch";
import { CEEAnswerCard } from "./CEEAnswerCard";
import { CEECharacterImage } from "./CEECharacterImage";
import { CEEFeedbackTable } from "./CEEFeedbackTable";
import { CEEReplay } from "./CEEReplay";
import { CEEWaiting } from "./CEEWaiting";
import { CEEChoosingSetter } from "./CEEChoosingSetter";

/**
 * 单次行动倒计时；没有截止时刻时整体不渲染，不留空行。
 * 三游戏共用同一个徽章，显示与警示都走公共实现。
 */
function Countdown({ deadline, className }: { deadline: number | null; className?: string }) {
  if (!deadline) return null;
  return (
    <div className={className ?? "flex justify-center"}>
      <CountdownBadge deadlineAt={deadline} />
    </div>
  );
}

/**
 * 阶段舞台承载全部阶段：与另外两个游戏的滚动区、内边距和阶段切换一致。
 * 阶段标识含来源与局数，换局或换来源时整体重挂载，各阶段内的草稿不会串局。
 * 回放的整局历史同理不能留在舞台内（换局会被重挂载清空），由房间页累积后传入。
 */
export function CEEGameArea({
  snapshot,
  privateState,
  replayRounds = [],
}: {
  snapshot: CEERoomSnapshot;
  privateState: CEEPrivateState;
  replayRounds?: ReplayRound[];
}) {
  return (
    <PhaseStage phaseKey={`${snapshot.source}:${snapshot.phase}:${snapshot.roundNumber}`}>
      <CEEPhase snapshot={snapshot} privateState={privateState} replayRounds={replayRounds} />
    </PhaseStage>
  );
}

function CEEPhase({
  snapshot,
  privateState,
  replayRounds,
}: {
  snapshot: CEERoomSnapshot;
  privateState: CEEPrivateState;
  replayRounds: ReplayRound[];
}) {
  if (snapshot.phase === "waiting")
    return <CEEWaiting snapshot={snapshot} privateState={privateState} />;
  if (snapshot.phase === "choosingSetter")
    return <CEEChoosingSetter snapshot={snapshot} privateState={privateState} />;
  if (snapshot.phase === "settled" && snapshot.roundSummary)
    return (
      <CEESettlement snapshot={snapshot} privateState={privateState} replayRounds={replayRounds} />
    );
  if (snapshot.phase === "answering")
    return <CEESetter snapshot={snapshot} privateState={privateState} />;
  if (snapshot.phase === "preparing")
    return <CEEPreparing snapshot={snapshot} privateState={privateState} />;
  return <CEEGuessing snapshot={snapshot} privateState={privateState} />;
}

/** 等待类阶段的开头：标题 → 说明 → 倒计时，准备题目与等待出题人同一顺序。 */
function PhaseIntro({
  icon,
  title,
  description,
  deadline,
}: {
  icon: typeof Search;
  title: string;
  description: ReactNode;
  deadline: number | null;
}) {
  return (
    <div className="space-y-3 text-center">
      <PhaseHeader icon={icon} title={title} />
      <div className="text-sm text-muted-foreground">{description}</div>
      <Countdown deadline={deadline} />
    </div>
  );
}

function CEEPreparing({
  snapshot,
  privateState,
}: {
  snapshot: CEERoomSnapshot;
  privateState: CEEPrivateState;
}) {
  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseIntro
        icon={Dices}
        title="正在准备题目"
        // 抽题是服务端在跑的持续状态：转圈与文字一起放进 status，读屏读出这一句
        description={
          <p role="status" className="inline-flex items-center gap-2">
            <Spinner className="text-primary" />
            题目就绪后会自动开始
          </p>
        }
        deadline={snapshot.phaseDeadlineAt}
      />
      <PhaseActions>
        <CancelRound snapshot={snapshot} playerId={privateState.playerId} />
      </PhaseActions>
    </div>
  );
}

/** 阶段底部的次要操作行：靠右排，「取消本局」在三处等待/出题阶段都落在这里。 */
function PhaseActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2 empty:hidden">{children}</div>;
}

/** 增强房房主在准备题目与出题阶段可以取消本局，退回等待；确认弹窗自按钮展开。 */
function CancelRound({ snapshot, playerId }: { snapshot: CEERoomSnapshot; playerId: string }) {
  const { run, pending } = useCEEAction();
  const [open, setOpen] = useState(false);
  const origin = useOriginTracker();
  if (
    snapshot.source !== "native" ||
    snapshot.hostPlayerId !== playerId ||
    !["preparing", "answering"].includes(snapshot.phase)
  )
    return null;
  const cancelling = pending.has("cee.game.cancel");
  const handleCancel = async () => {
    if (await run("cee.game.cancel", {})) setOpen(false);
  };
  return (
    <>
      <Button
        variant="outline"
        loading={cancelling}
        onClick={(event) => {
          origin.capture(event);
          setOpen(true);
        }}
      >
        取消本局
      </Button>
      <Dialog open={open} onOpenChange={setOpen} origin={origin.origin}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>取消本局</DialogTitle>
            <DialogDescription>
              本局不计分，房间回到等待阶段，可以调整设置后重新开始。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              继续本局
            </Button>
            <Button variant="destructive" loading={cancelling} onClick={() => void handleCancel()}>
              确认取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 已选答案：与搜索结果同一款行（缩略图、主名、副名），行尾的关闭钮清除选择。 */
function SelectedAnswer({ answer, onClear }: { answer: CEECharacterSummary; onClear: () => void }) {
  const title = answer.nameCn || answer.name;
  return (
    <div className="flex min-h-11 items-center gap-3 rounded-md bg-muted px-3 py-2 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">已选择</span>
      <SearchOptionContent
        media={<CEECharacterImage character={answer} className="size-9 bg-background" />}
        title={title}
        subtitle={answer.name !== title ? `${answer.name} · #${answer.id}` : `#${answer.id}`}
      />
      <CloseButton aria-label="清除已选答案" onClick={onClear} />
    </div>
  );
}

function CEESetter({
  snapshot,
  privateState,
}: {
  snapshot: CEERoomSnapshot;
  privateState: CEEPrivateState;
}) {
  const [answer, setAnswer] = useState<CEECharacterSummary | null>(null);
  const [hints, setHints] = useState(["", "", ""]);
  const { run, pending } = useCEEAction();
  const submitting = pending.has("cee.game.setAnswer");
  const setterName =
    snapshot.players.find((player) => player.id === snapshot.setterPlayerId)?.name ?? "出题人";
  if (!privateState.canSetAnswer) {
    return (
      <div className="mx-auto w-full max-w-md space-y-5">
        <PhaseIntro
          icon={PenLine}
          title="等待出题人"
          description={<p>{setterName} 正在选择角色</p>}
          deadline={snapshot.phaseDeadlineAt}
        />
        <PhaseActions>
          <CancelRound snapshot={snapshot} playerId={privateState.playerId} />
        </PhaseActions>
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <PhaseIntro
        icon={PenLine}
        title="选择本局答案"
        description={<p>搜索并选中一位角色作为答案，结算前只有你和旁观者能看到。</p>}
        deadline={snapshot.phaseDeadlineAt}
      />
      <CEESearch allowSubjects disabled={submitting} onSelect={setAnswer} />
      <div aria-live="polite">
        <CollapsibleRegion open={answer !== null}>
          {answer ? <SelectedAnswer answer={answer} onClear={() => setAnswer(null)} /> : null}
        </CollapsibleRegion>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">文本提示（可选）</legend>
        {hints.map((hint, index) => (
          <Input
            key={index}
            className="h-10"
            value={hint}
            maxLength={30}
            aria-label={`文本提示 ${index + 1}`}
            placeholder={`文本提示 ${index + 1}`}
            onChange={(event) =>
              setHints((current) =>
                current.map((value, position) => (index === position ? event.target.value : value))
              )
            }
          />
        ))}
      </fieldset>
      <Button
        size="lg"
        className="w-full"
        disabled={!answer || submitting}
        loading={submitting}
        onClick={() => answer && void run("cee.game.setAnswer", { characterId: answer.id, hints })}
      >
        确认答案并开始
      </Button>
      <PhaseActions>
        <CancelRound snapshot={snapshot} playerId={privateState.playerId} />
      </PhaseActions>
    </div>
  );
}

/** 猜测阶段的行动状态：搜索栏、同步回执、已结束等待结算，或不给可行动者入口。 */
type GuessSlotKind = "search" | "done" | "ended";

/** 次数行的身份说明：出题人、其观战队友与中途加入者在服务端都记为观战，次数对他们没有意义。 */
function standingNote(
  player: CEEPlayer | undefined,
  setterPlayerId: string | null,
  maxAttempts: number
): string {
  if (!player || player.membership === "spectator") return "旁观中";
  if (setterPlayerId === player.id) return "你是本局出题人";
  if (player.status === "observing") return "本局观战";
  return `已用 ${player.attempts} / ${maxAttempts} 次${player.team !== null ? ` · 第 ${player.team} 队共享` : ""}`;
}

/** 标题随本轮是否已提交换字：能猜 → 本轮已交 → 本局仍在跑（自己不能再行动）。 */
function guessingTitle(canGuess: boolean, waitingSync: boolean): string {
  if (canGuess) return "猜猜是哪位角色";
  if (waitingSync) return "本轮已提交";
  return "本局进行中";
}

/** 可行动者给搜索栏，同步等待给回执，其余按能否看到答案决定；与标题同一口径。 */
function guessSlotKind(
  canGuess: boolean,
  waitingSync: boolean,
  watching: boolean
): GuessSlotKind | null {
  if (canGuess) return "search";
  if (waitingSync) return "done";
  if (watching) return null;
  return "ended";
}

/** 次数与倒计时同一行：身份说明、答案保密提示与同步轮号，倒计时靠右。 */
function GuessingMetaLine({
  standing,
  watching,
  syncMode,
  syncRound,
  deadline,
}: {
  standing: string;
  watching: boolean;
  syncMode: boolean;
  syncRound: number;
  deadline: number | null;
}) {
  return (
    <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>
        {standing}
        {watching ? " · 答案对猜题者隐藏" : null}
        {syncMode ? ` · 同步第 ${syncRound} 轮` : null}
      </span>
      <Countdown deadline={deadline} className="ml-auto" />
    </div>
  );
}

/** 同步模式本轮已提交的回执：图标跟随卡片一起落下，等其他人本轮也提交。 */
function SyncDoneReceipt({ trailing }: { trailing: ReactNode }) {
  return (
    <>
      <motion.p
        role="status"
        {...receiptCard}
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-medium"
      >
        <motion.span className="inline-flex shrink-0" {...receiptMarkFollow}>
          <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" />
        </motion.span>
        本轮已完成，等待其他玩家
      </motion.p>
      {trailing}
    </>
  );
}

/** 本局不再接受行动：只剩等待结算的说明。 */
function RoundEndedNote({ trailing }: { trailing: ReactNode }) {
  return (
    <>
      <p
        role="status"
        className="flex min-h-10 min-w-0 flex-1 items-center text-sm text-muted-foreground"
      >
        本局已结束行动，等待结算
      </p>
      {trailing}
    </>
  );
}

/**
 * 提交区：搜索栏与本轮回执叠在同一格里交叉，槽位种类决定挂哪个 key，退场才对得上。
 * 看到答案的视角把说明行放在外面（与答案卡相邻），这里不再重复。
 */
function GuessSubmitArea({
  info,
  watching,
  slot,
  subjectSearch,
  bannedIds,
  trailing,
  onPick,
}: {
  info: ReactNode;
  watching: boolean;
  slot: GuessSlotKind;
  subjectSearch: boolean;
  bannedIds: number[];
  trailing: ReactNode;
  onPick: (character: CEECharacterSummary) => Promise<boolean>;
}) {
  return (
    <section aria-label="提交猜测" className="space-y-2">
      {watching ? null : info}
      {/* 搜索栏与本轮回执叠在同一格里交叉：同步模式提交后回执落下，下一轮开始时搜索栏回来 */}
      <div className="relative">
        <AnimatePresence initial={false} mode="popLayout">
          {slot === "search" ? (
            <GuessSlot key="search">
              <CEESearch
                allowSubjects={subjectSearch}
                bannedIds={bannedIds}
                trailing={trailing}
                onSelect={onPick}
              />
            </GuessSlot>
          ) : slot === "done" ? (
            <GuessSlot key="done" className="flex items-start gap-2">
              <SyncDoneReceipt trailing={trailing} />
            </GuessSlot>
          ) : (
            <GuessSlot key="ended" className="flex items-start gap-2">
              <RoundEndedNote trailing={trailing} />
            </GuessSlot>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

function CEEGuessing({
  snapshot,
  privateState,
}: {
  snapshot: CEERoomSnapshot;
  privateState: CEEPrivateState;
}) {
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const [surrenderOpen, setSurrenderOpen] = useState(false);
  const origin = useOriginTracker();
  const { run, pending } = useCEEAction();
  const surrendering = pending.has("cee.game.surrender");
  const waitingSync = Boolean(
    snapshot.settings.syncMode && me?.syncCompleted && me.status === "playing"
  );
  const standing = standingNote(me, snapshot.setterPlayerId, snapshot.settings.maxAttempts);
  const title = guessingTitle(privateState.canGuess, waitingSync);
  // 看得到答案的视角不提交猜测：说明行与答案卡相邻，读作「下面这张卡就是答案」。
  const watching = Boolean(privateState.answer);
  const info = (
    <GuessingMetaLine
      standing={standing}
      watching={watching}
      syncMode={snapshot.settings.syncMode}
      syncRound={snapshot.syncRound}
      deadline={privateState.deadlineAt}
    />
  );
  // 放弃按钮挂在搜索按钮组的末尾：搜索栏为了不让输入框被挤窄会把按钮组整组换行，放在外面会先把搜索按钮挤下去。
  // 按钮组按下时会把焦点交回输入框，这里拦下，焦点留在按钮上，弹窗关闭后才回得来。
  const surrender = privateState.canSurrender ? (
    <Button
      variant="outline"
      className="h-10 shrink-0 px-3"
      loading={surrendering}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        origin.capture(event);
        setSurrenderOpen(true);
      }}
    >
      <Flag />
      放弃本局
    </Button>
  ) : null;
  const slot = guessSlotKind(privateState.canGuess, waitingSync, watching);
  const handleSurrender = async () => {
    if (await run("cee.game.surrender", {})) setSurrenderOpen(false);
  };
  const handlePick = async (character: CEECharacterSummary) =>
    Boolean(await run("cee.game.guess", { characterId: character.id }));

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      {/* 标题随本轮是否已提交换字：新标题自下顶上，旧标题立即让位 */}
      <div className="relative">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={title}
            variants={readoutSwap}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <PhaseHeader icon={Search} title={title} />
          </motion.div>
        </AnimatePresence>
      </div>
      {watching ? (
        <>
          {info}
          <CEEAnswerCard answer={privateState.answer!} />
        </>
      ) : null}
      <CEEHints privateState={privateState} />
      {slot ? (
        <GuessSubmitArea
          info={info}
          watching={watching}
          slot={slot}
          subjectSearch={snapshot.settings.subjectSearch}
          bannedIds={privateState.bannedCharacterIds}
          trailing={surrender}
          onPick={handlePick}
        />
      ) : null}
      <CEEFeedbackTable guesses={privateState.guesses} showRound={snapshot.settings.syncMode} />
      <Dialog open={surrenderOpen} onOpenChange={setSurrenderOpen} origin={origin.origin}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>放弃本局</DialogTitle>
            <DialogDescription>确认后本局无法继续猜测，组队时会影响整个队伍。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSurrenderOpen(false)}>
              继续猜测
            </Button>
            <Button
              variant="destructive"
              loading={surrendering}
              onClick={() => void handleSurrender()}
            >
              确认放弃
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 猜测栏里交替的一格：只负责退场淡出，入场由各自内容（回执回弹、搜索栏照常出现）决定。 */
function GuessSlot({
  ref,
  className,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  className?: string;
  children: ReactNode;
}) {
  return (
    <motion.div ref={ref} exit={skeletonFade.exit} className={className}>
      {children}
    </motion.div>
  );
}

/**
 * 提示区：文本提示与图片提示按剩余次数中途解锁。整块经 CollapsibleRegion 展开，新提示以 listItem 推入；
 * 外层 aria-live 让读屏在解锁时读出新内容。
 */
function CEEHints({ privateState }: { privateState: CEEPrivateState }) {
  const { hints, imageHintAvailable } = privateState;
  return (
    <div aria-live="polite">
      <CollapsibleRegion open={hints.length > 0 || imageHintAvailable}>
        <div className="space-y-3 rounded-md bg-muted p-3">
          {/* 列表常驻，第一条提示也走入场；没有文本提示时不占位 */}
          <ul className={hints.length ? "space-y-2" : "hidden"}>
            <AnimatePresence initial={false}>
              {hints.map((hint, index) => (
                <motion.li
                  key={index}
                  variants={listItem}
                  initial="initial"
                  animate="animate"
                  className="origin-left text-sm"
                >
                  提示 {index + 1}：{hint}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          <CollapsibleRegion open={imageHintAvailable}>
            <CEEImageHint level={privateState.imageHintLevel} />
          </CollapsibleRegion>
        </div>
      </CollapsibleRegion>
    </div>
  );
}

/**
 * 图片提示：按钮只看自己的请求。第一次请求时固定高度的占位格展开，图片落在格里；
 * 之后换档只在格内替换（新图自下顶上），外框不再伸缩，级数随之读出。
 */
function CEEImageHint({ level }: { level: number }) {
  const [image, setImage] = useState<{ level: number; dataUrl: string } | null>(null);
  const { run, pending } = useCEEAction();
  const loading = pending.has("cee.game.imageHint");
  const handleImageHint = async () => {
    const result = await run("cee.game.imageHint", {});
    if (result) setImage({ dataUrl: result.dataUrl, level });
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" loading={loading} onClick={() => void handleImageHint()}>
          <Image />
          {image ? "更新图片提示" : "查看图片提示"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {image ? `当前第 ${image.level} 级` : null}
        </span>
      </div>
      <CollapsibleRegion open={image !== null || loading}>
        <div className="grid h-48 place-items-center overflow-hidden rounded-md bg-background">
          <AnimatePresence initial={false}>
            {image ? (
              <motion.img
                key={image.level}
                variants={readoutSwap}
                initial="initial"
                animate="animate"
                exit="exit"
                src={image.dataUrl}
                alt={`第 ${image.level} 级图片提示`}
                className="max-h-full max-w-full object-contain [grid-area:1/1]"
              />
            ) : (
              <motion.span
                key="empty"
                exit={skeletonFade.exit}
                className="inline-flex items-center gap-2 text-xs text-muted-foreground [grid-area:1/1]"
              >
                <Spinner />
                正在生成图片提示
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </CollapsibleRegion>
    </div>
  );
}

type CEEScore = NonNullable<CEERoomSnapshot["roundSummary"]>["scores"][number];

const CEE_SCORE_COLUMNS: ScoreTableColumn[] = [
  { key: "rank", header: "名次" },
  { key: "score", header: "得分", signed: true, tone: "strong" },
];

/** 猜中者按名次在前；同名次、没有名次的（未猜中、作品命中、出题人）保持服务端给的顺序。 */
const byRank = (score: CEEScore) => score.rank ?? Number.MAX_SAFE_INTEGER;

/** 结算得分表：按名次排列、自末行往上揭示；得分明细作名字下方的次行，窄屏不逐字换行。 */
function CEEScoreTable({ scores, guesses }: { scores: CEEScore[]; guesses: CEEGuess[] }) {
  // 本局猜中的人：命中作品只拿 partial 分，不算猜中，因此以 guesses 的 correct 为准而不是得分明细。
  const contributors = new Set(
    guesses.filter((guess) => guess.correct).map((guess) => guess.playerId)
  );
  return (
    <ScoreTable
      title="本局得分"
      columns={CEE_SCORE_COLUMNS}
      ranked
      rows={[...scores]
        .sort((left, right) => byRank(left) - byRank(right))
        .map((score) => ({
          key: score.playerId,
          name: score.playerName,
          detail: [
            ...(score.reason ? [score.reason] : []),
            `基础 ${score.base}`,
            `首猜 ${score.firstGuess}`,
            `快速 ${score.quickGuess}`,
            `作品 ${score.partial}`,
            `出题 ${score.setter}`,
          ],
          cells: { rank: score.rank ?? "—", score: score.score },
          rollFrom: { score: 0 },
          contributor: contributors.has(score.playerId),
        }))}
    />
  );
}

/**
 * 结算。增强房的「下一步」是回到等待阶段（可改设置、重新准备）或直接再来一轮；原版房按上游行为直接开下一局，
 * 手动出题时先进入指定出题人。非房主的说明按同一口径写。
 */
function CEESettlement({
  snapshot,
  privateState,
  replayRounds,
}: {
  snapshot: CEERoomSnapshot;
  privateState: CEEPrivateState;
  replayRounds: ReplayRound[];
}) {
  const summary = snapshot.roundSummary!;
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const { run, pending } = useCEEAction();
  const advancing = pending.has("cee.game.next");
  const starting = pending.has("cee.game.start");
  const native = snapshot.source === "native";
  const manual = snapshot.settings.answerMode === "manual";
  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <PhaseHeader icon={Trophy} title="答案揭晓" />
      <CEEAnswerCard answer={summary.answer} sealed />
      <CEEScoreTable scores={summary.scores} guesses={summary.guesses} />
      {/* 反作弊房在房间里的全部可见性就是这一句：不点名、不指控，也不暴露任何判定分值。 */}
      {snapshot.bakaAntiCheat && (
        <p className="text-center text-xs text-muted-foreground">
          反作弊房：本局已记录，仅用于人工复核
        </p>
      )}
      {/* 回放先只对开了本地开关的人可见（见 lib/CeeReplay），未开时整块不渲染 */}
      <CEEReplay key={snapshot.roundNumber} rounds={replayRounds} />
      <div className="flex flex-wrap justify-center gap-2">
        {isHost ? (
          native ? (
            <>
              <Button
                variant="outline"
                size="lg"
                disabled={advancing || starting}
                loading={advancing}
                onClick={() => void run("cee.game.next", {})}
              >
                返回等待房间
              </Button>
              <Button
                size="lg"
                disabled={!privateState.canStart || advancing || starting}
                loading={starting}
                onClick={() => void run("cee.game.start", {})}
              >
                再来一轮
              </Button>
            </>
          ) : (
            <Button size="lg" loading={advancing} onClick={() => void run("cee.game.next", {})}>
              {manual ? "指定下一局出题人" : "开始下一局"}
            </Button>
          )
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            {native
              ? "等待房主开始下一轮"
              : manual
                ? "等待房主指定下一局出题人"
                : "等待房主开始下一局"}
          </p>
        )}
      </div>
      <CEEFeedbackTable guesses={summary.guesses} showRound={snapshot.settings.syncMode} />
    </div>
  );
}
