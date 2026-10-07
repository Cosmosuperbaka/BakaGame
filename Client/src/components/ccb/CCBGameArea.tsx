import { useState, type ReactNode, type Ref } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Dices, Flag, Image, PenLine, Search, Trophy } from "lucide-react";
import type { CCBCharacterSummary, CCBGuess, CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { CloseButton } from "@/components/ui/CloseButton";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { SearchOptionContent } from "@/components/common/SearchCombobox";
import { CountdownBadge } from "@/components/common/room/CountdownBadge";
import { PhaseStage } from "@/components/common/room/PhaseStage";
import { ScoreTable, type ScoreTableColumn } from "@/components/common/room/ScoreTable";
import { useOriginTracker } from "@/hooks/UseOriginTracker";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { listItem, readoutSwap, receiptCard, receiptMarkFollow, skeletonFade } from "@/lib/Motion";
import { CCBSearch } from "./CCBSearch";
import { CCBAnswerCard } from "./CCBAnswerCard";
import { CCBCharacterImage } from "./CCBCharacterImage";
import { CCBFeedbackTable } from "./CCBFeedbackTable";
import { CCBWaiting } from "./CCBWaiting";
import { CCBChoosingSetter } from "./CCBChoosingSetter";

/**
 * 单次行动倒计时；没有截止时刻时整体不渲染，不留空行。
 * 三游戏共用同一个徽章，显示与警示都走公共实现。
 */
function Countdown({ deadline, className }: { deadline: number | null; className?: string }) {
  if (!deadline) return null;
  return <div className={className ?? "flex justify-center"}><CountdownBadge deadlineAt={deadline} /></div>;
}

/**
 * 阶段舞台承载全部阶段：与另外两个游戏的滚动区、内边距和阶段切换一致。
 * 阶段标识含来源与局数，换局或换来源时整体重挂载，各阶段内的草稿不会串局。
 */
export function CCBGameArea({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  return (
    <PhaseStage phaseKey={`${snapshot.source}:${snapshot.phase}:${snapshot.roundNumber}`}>
      <CCBPhase snapshot={snapshot} privateState={privateState} />
    </PhaseStage>
  );
}

function CCBPhase({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  if (snapshot.phase === "waiting") return <CCBWaiting snapshot={snapshot} privateState={privateState} />;
  if (snapshot.phase === "choosingSetter") return <CCBChoosingSetter snapshot={snapshot} privateState={privateState} />;
  if (snapshot.phase === "settled" && snapshot.roundSummary) return <CCBSettlement snapshot={snapshot} privateState={privateState} />;
  if (snapshot.phase === "answering") return <CCBSetter snapshot={snapshot} privateState={privateState} />;
  if (snapshot.phase === "preparing") return <CCBPreparing snapshot={snapshot} privateState={privateState} />;
  return <CCBGuessing snapshot={snapshot} privateState={privateState} />;
}

/** 等待类阶段的开头：标题 → 说明 → 倒计时，准备题目与等待出题人同一顺序。 */
function PhaseIntro({ icon, title, description, deadline }: { icon: typeof Search; title: string; description: ReactNode; deadline: number | null }) {
  return (
    <div className="space-y-3 text-center">
      <PhaseHeader icon={icon} title={title} />
      <div className="text-sm text-muted-foreground">{description}</div>
      <Countdown deadline={deadline} />
    </div>
  );
}

function CCBPreparing({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  return (
    <div className="mx-auto w-full max-w-md space-y-5">
      <PhaseIntro
        icon={Dices}
        title="正在准备题目"
        // 抽题是服务端在跑的持续状态：转圈与文字一起放进 status，读屏读出这一句
        description={<p role="status" className="inline-flex items-center gap-2"><Spinner className="text-primary" />题目就绪后会自动开始</p>}
        deadline={snapshot.phaseDeadlineAt}
      />
      <PhaseActions><CancelRound snapshot={snapshot} playerId={privateState.playerId} /></PhaseActions>
    </div>
  );
}

/** 阶段底部的次要操作行：靠右排，「取消本局」在三处等待/出题阶段都落在这里。 */
function PhaseActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2 empty:hidden">{children}</div>;
}

/** 增强房房主在准备题目与出题阶段可以取消本局，退回等待；确认弹窗自按钮展开。 */
function CancelRound({ snapshot, playerId }: { snapshot: CCBRoomSnapshot; playerId: string }) {
  const { run, pending } = useCCBAction();
  const [open, setOpen] = useState(false);
  const origin = useOriginTracker();
  if (snapshot.source !== "native" || snapshot.hostPlayerId !== playerId || !["preparing", "answering"].includes(snapshot.phase)) return null;
  const cancelling = pending.has("ccb.game.cancel");
  return <>
    <Button variant="outline" loading={cancelling} onClick={(event) => { origin.capture(event); setOpen(true); }}>取消本局</Button>
    <Dialog open={open} onOpenChange={setOpen} origin={origin.origin}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>取消本局</DialogTitle>
          <DialogDescription>本局不计分，房间回到等待阶段，可以调整设置后重新开始。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>继续本局</Button>
          <Button variant="destructive" loading={cancelling} onClick={async () => { if (await run("ccb.game.cancel", {})) setOpen(false); }}>确认取消</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

/** 已选答案：与搜索结果同一款行（缩略图、主名、副名），行尾的关闭钮清除选择。 */
function SelectedAnswer({ answer, onClear }: { answer: CCBCharacterSummary; onClear: () => void }) {
  const title = answer.nameCn || answer.name;
  return (
    <div className="flex min-h-11 items-center gap-3 rounded-md bg-muted px-3 py-2 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">已选择</span>
      <SearchOptionContent
        media={<CCBCharacterImage character={answer} className="size-9 bg-background" />}
        title={title}
        subtitle={answer.name !== title ? `${answer.name} · #${answer.id}` : `#${answer.id}`}
      />
      <CloseButton aria-label="清除已选答案" onClick={onClear} />
    </div>
  );
}

function CCBSetter({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const [answer, setAnswer] = useState<CCBCharacterSummary | null>(null);
  const [hints, setHints] = useState(["", "", ""]);
  const { run, pending } = useCCBAction();
  const submitting = pending.has("ccb.game.setAnswer");
  const setterName = snapshot.players.find((player) => player.id === snapshot.setterPlayerId)?.name ?? "出题人";
  if (!privateState.canSetAnswer) {
    return (
      <div className="mx-auto w-full max-w-md space-y-5">
        <PhaseIntro icon={PenLine} title="等待出题人" description={<p>{setterName} 正在选择角色</p>} deadline={snapshot.phaseDeadlineAt} />
        <PhaseActions><CancelRound snapshot={snapshot} playerId={privateState.playerId} /></PhaseActions>
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <PhaseIntro icon={PenLine} title="选择本局答案" description={<p>搜索并选中一位角色作为答案，结算前只有你和旁观者能看到。</p>} deadline={snapshot.phaseDeadlineAt} />
      <CCBSearch allowSubjects defaultMode={snapshot.source === "native" ? "subject" : "character"} disabled={submitting} onSelect={setAnswer} />
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
            onChange={(event) => setHints((current) => current.map((value, position) => index === position ? event.target.value : value))}
          />
        ))}
      </fieldset>
      <Button size="lg" className="w-full" disabled={!answer || submitting} loading={submitting} onClick={() => answer && void run("ccb.game.setAnswer", { characterId: answer.id, hints })}>确认答案并开始</Button>
      <PhaseActions><CancelRound snapshot={snapshot} playerId={privateState.playerId} /></PhaseActions>
    </div>
  );
}

function CCBGuessing({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const [surrenderOpen, setSurrenderOpen] = useState(false);
  const origin = useOriginTracker();
  const { run, pending } = useCCBAction();
  const surrendering = pending.has("ccb.game.surrender");
  const waitingSync = Boolean(snapshot.settings.syncMode && me?.syncCompleted && me.status === "playing");
  // 出题人、其观战队友与中途加入者在服务端都记为观战，次数对他们没有意义。
  const standing = !me || me.membership === "spectator" ? "旁观中"
    : snapshot.setterPlayerId === me.id ? "你是本局出题人"
      : me.status === "observing" ? "本局观战"
        : `已用 ${me.attempts} / ${snapshot.settings.maxAttempts} 次${me.team !== null ? ` · 第 ${me.team} 队共享` : ""}`;
  const title = privateState.canGuess ? "猜猜是哪位角色" : waitingSync ? "本轮已提交" : "本局进行中";
  // 看得到答案的视角不提交猜测：说明行与答案卡相邻，读作「下面这张卡就是答案」。
  const watching = Boolean(privateState.answer);
  const info = (
    <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>
        {standing}
        {watching ? " · 答案对猜题者隐藏" : null}
        {snapshot.settings.syncMode ? ` · 同步第 ${snapshot.syncRound} 轮` : null}
      </span>
      <Countdown deadline={privateState.deadlineAt} className="ml-auto" />
    </div>
  );
  // 放弃按钮挂在搜索按钮组的末尾：搜索栏为了不让输入框被挤窄会把按钮组整组换行，放在外面会先把搜索按钮挤下去。
  // 按钮组按下时会把焦点交回输入框，这里拦下，焦点留在按钮上，弹窗关闭后才回得来。
  const surrender = privateState.canSurrender ? (
    <Button variant="outline" className="h-10 shrink-0 px-3" loading={surrendering} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { origin.capture(event); setSurrenderOpen(true); }}><Flag />放弃本局</Button>
  ) : null;
  const slot = privateState.canGuess ? "search" : waitingSync ? "done" : !watching ? "ended" : null;

  return <div className="mx-auto w-full max-w-2xl space-y-5">
    {/* 标题随本轮是否已提交换字：新标题自下顶上，旧标题立即让位 */}
    <div className="relative">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div key={title} variants={readoutSwap} initial="initial" animate="animate" exit="exit">
          <PhaseHeader icon={Search} title={title} />
        </motion.div>
      </AnimatePresence>
    </div>
    {watching ? <>{info}<CCBAnswerCard answer={privateState.answer!} /></> : null}
    <CCBHints privateState={privateState} />
    {slot ? (
      <section aria-label="提交猜测" className="space-y-2">
        {watching ? null : info}
        {/* 搜索栏与本轮回执叠在同一格里交叉：同步模式提交后回执落下，下一轮开始时搜索栏回来 */}
        <div className="relative">
          <AnimatePresence initial={false} mode="popLayout">
            {slot === "search" ? (
              <GuessSlot key="search">
                <CCBSearch allowSubjects={snapshot.settings.subjectSearch} defaultMode={snapshot.source === "native" ? "subject" : "character"} bannedIds={privateState.bannedCharacterIds} trailing={surrender} onSelect={async (character) => Boolean(await run("ccb.game.guess", { characterId: character.id }))} />
              </GuessSlot>
            ) : slot === "done" ? (
              <GuessSlot key="done" className="flex items-start gap-2">
                <motion.p role="status" {...receiptCard} className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-medium">
                  <motion.span className="inline-flex shrink-0" {...receiptMarkFollow}><CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" /></motion.span>
                  本轮已完成，等待其他玩家
                </motion.p>
                {surrender}
              </GuessSlot>
            ) : (
              <GuessSlot key="ended" className="flex items-start gap-2">
                <p role="status" className="flex min-h-10 min-w-0 flex-1 items-center text-sm text-muted-foreground">本局已结束行动，等待结算</p>
                {surrender}
              </GuessSlot>
            )}
          </AnimatePresence>
        </div>
      </section>
    ) : null}
    <CCBFeedbackTable guesses={privateState.guesses} showRound={snapshot.settings.syncMode} />
    <Dialog open={surrenderOpen} onOpenChange={setSurrenderOpen} origin={origin.origin}><DialogContent><DialogHeader><DialogTitle>放弃本局</DialogTitle><DialogDescription>确认后本局无法继续猜测，组队时会影响整个队伍。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setSurrenderOpen(false)}>继续猜测</Button><Button variant="destructive" loading={surrendering} onClick={async () => { if (await run("ccb.game.surrender", {})) setSurrenderOpen(false); }}>确认放弃</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

/** 猜测栏里交替的一格：只负责退场淡出，入场由各自内容（回执回弹、搜索栏照常出现）决定。 */
function GuessSlot({ ref, className, children }: { ref?: Ref<HTMLDivElement>; className?: string; children: ReactNode }) {
  return <motion.div ref={ref} exit={skeletonFade.exit} className={className}>{children}</motion.div>;
}

/**
 * 提示区：文本提示与图片提示按剩余次数中途解锁。整块经 CollapsibleRegion 展开，新提示以 listItem 推入；
 * 外层 aria-live 让读屏在解锁时读出新内容。
 */
function CCBHints({ privateState }: { privateState: CCBPrivateState }) {
  const { hints, imageHintAvailable } = privateState;
  return (
    <div aria-live="polite">
      <CollapsibleRegion open={hints.length > 0 || imageHintAvailable}>
        <div className="space-y-3 rounded-md bg-muted p-3">
          {/* 列表常驻，第一条提示也走入场；没有文本提示时不占位 */}
          <ul className={hints.length ? "space-y-2" : "hidden"}>
            <AnimatePresence initial={false}>
              {hints.map((hint, index) => (
                <motion.li key={index} variants={listItem} initial="initial" animate="animate" className="origin-left text-sm">提示 {index + 1}：{hint}</motion.li>
              ))}
            </AnimatePresence>
          </ul>
          <CollapsibleRegion open={imageHintAvailable}>
            <CCBImageHint level={privateState.imageHintLevel} />
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
function CCBImageHint({ level }: { level: number }) {
  const [image, setImage] = useState<{ level: number; dataUrl: string } | null>(null);
  const { run, pending } = useCCBAction();
  const loading = pending.has("ccb.game.imageHint");
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" loading={loading} onClick={async () => { const result = await run("ccb.game.imageHint", {}); if (result) setImage({ dataUrl: result.dataUrl, level }); }}><Image />{image ? "更新图片提示" : "查看图片提示"}</Button>
        <span className="text-xs text-muted-foreground">{image ? `当前第 ${image.level} 级` : null}</span>
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
              <motion.span key="empty" exit={skeletonFade.exit} className="inline-flex items-center gap-2 text-xs text-muted-foreground [grid-area:1/1]"><Spinner />正在生成图片提示</motion.span>
            )}
          </AnimatePresence>
        </div>
      </CollapsibleRegion>
    </div>
  );
}

type CCBScore = NonNullable<CCBRoomSnapshot["roundSummary"]>["scores"][number];

const CCB_SCORE_COLUMNS: ScoreTableColumn[] = [
  { key: "rank", header: "名次" },
  { key: "score", header: "得分", signed: true, tone: "strong" },
];

/** 猜中者按名次在前；同名次、没有名次的（未猜中、作品命中、出题人）保持服务端给的顺序。 */
const byRank = (score: CCBScore) => score.rank ?? Number.MAX_SAFE_INTEGER;

/** 结算得分表：按名次排列、自末行往上揭示；得分明细作名字下方的次行，窄屏不逐字换行。 */
function CCBScoreTable({ scores, guesses }: { scores: CCBScore[]; guesses: CCBGuess[] }) {
  // 本局猜中的人：命中作品只拿 partial 分，不算猜中，因此以 guesses 的 correct 为准而不是得分明细。
  const contributors = new Set(guesses.filter((guess) => guess.correct).map((guess) => guess.playerId));
  return (
    <ScoreTable
      title="本局得分"
      columns={CCB_SCORE_COLUMNS}
      ranked
      rows={[...scores].sort((left, right) => byRank(left) - byRank(right)).map((score) => ({
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
        // 同步模式下同一轮猜中的并列第一
        winner: score.rank === 1,
      }))}
    />
  );
}

/**
 * 结算。增强房的「下一步」是回到等待阶段（可改设置、重新准备）；原版房按上游行为直接开下一局，
 * 手动出题时先进入指定出题人。非房主的说明按同一口径写。
 */
function CCBSettlement({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const summary = snapshot.roundSummary!;
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const { run, pending } = useCCBAction();
  const advancing = pending.has("ccb.game.next");
  const native = snapshot.source === "native";
  const manual = snapshot.settings.answerMode === "manual";
  return <div className="mx-auto w-full max-w-2xl space-y-5">
    <PhaseHeader icon={Trophy} title="答案揭晓" />
    <CCBAnswerCard answer={summary.answer} sealed />
    <CCBScoreTable scores={summary.scores} guesses={summary.guesses} />
    <CCBFeedbackTable guesses={summary.guesses} showRound={snapshot.settings.syncMode} />
    <div className="flex flex-wrap justify-center gap-2">
      {isHost ? (
        <Button size="lg" loading={advancing} onClick={() => void run("ccb.game.next", {})}>
          {native ? "返回等待房间" : manual ? "指定下一局出题人" : "开始下一局"}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          {native ? "等待房主返回等待阶段" : manual ? "等待房主指定下一局出题人" : "等待房主开始下一局"}
        </p>
      )}
    </div>
  </div>;
}
