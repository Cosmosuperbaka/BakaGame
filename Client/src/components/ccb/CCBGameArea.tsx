import { useState } from "react";
import { Flag, Image, Loader2, PenLine, RotateCcw, Search, Trophy } from "lucide-react";
import type { CCBCharacterSummary, CCBGuess, CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { CountdownBadge } from "@/components/common/room/CountdownBadge";
import { PhaseStage } from "@/components/common/room/PhaseStage";
import { ScoreTable, type ScoreTableColumn } from "@/components/common/room/ScoreTable";
import { useOriginTracker } from "@/hooks/UseOriginTracker";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { CCBSearch } from "./CCBSearch";
import { CCBAnswerCard } from "./CCBAnswerCard";
import { CCBFeedbackTable } from "./CCBFeedbackTable";
import { CCBWaiting } from "./CCBWaiting";
import { CCBSetterPicker } from "./CCBSetterPicker";

/**
 * 单次行动倒计时；没有截止时刻时不显示。
 * 三游戏共用同一个徽章，显示与警示都走公共实现。
 */
function Countdown({ deadline }: { deadline: number | null }) {
  return deadline ? <CountdownBadge deadlineAt={deadline} /> : null;
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
  if (snapshot.phase === "settled" && snapshot.roundSummary) return <CCBSettlement snapshot={snapshot} privateState={privateState} />;
  if (snapshot.phase === "answering") return <CCBSetter snapshot={snapshot} privateState={privateState} />;
  if (snapshot.phase === "preparing") return <div className="space-y-4 text-center"><PhaseHeader icon={Loader2} title="正在准备题目" /><p className="text-sm text-muted-foreground">题目就绪后会自动开始</p><Countdown deadline={snapshot.phaseDeadlineAt} /><CancelRound snapshot={snapshot} playerId={privateState.playerId} /></div>;
  return <CCBGuessing snapshot={snapshot} privateState={privateState} />;
}

function CancelRound({ snapshot, playerId }: { snapshot: CCBRoomSnapshot; playerId: string }) {
  const { run, busy } = useCCBAction();
  if (snapshot.source !== "native" || snapshot.hostPlayerId !== playerId || !["preparing", "answering"].includes(snapshot.phase)) return null;
  return <Button variant="outline" disabled={busy} onClick={() => void run("ccb.game.cancel", {})}>取消本局</Button>;
}

function CCBSetter({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const [answer, setAnswer] = useState<CCBCharacterSummary | null>(null);
  const [hints, setHints] = useState(["", "", ""]);
  const { run, busy } = useCCBAction();
  return <div className="mx-auto w-full max-w-2xl space-y-5">
    <PhaseHeader icon={PenLine} title={privateState.canSetAnswer ? "选择本局答案" : "等待出题人"} />
    <div className="flex justify-center"><Countdown deadline={snapshot.phaseDeadlineAt} /></div>
    {privateState.canSetAnswer ? <><CCBSearch allowSubjects disabled={busy} onSelect={setAnswer} />{answer ? <p className="rounded-md bg-muted p-3 text-sm">已选择：{answer.nameCn || answer.name}（#{answer.id}）</p> : null}<div className="space-y-2">{hints.map((hint, index) => <Input key={index} value={hint} maxLength={30} aria-label={`文本提示 ${index + 1}`} placeholder={`文本提示 ${index + 1}（可不填）`} onChange={(event) => setHints((current) => current.map((value, position) => index === position ? event.target.value : value))} />)}</div><Button className="w-full" disabled={!answer || busy} loading={busy} onClick={() => answer && void run("ccb.game.setAnswer", { characterId: answer.id, hints })}>确认答案并开始</Button></> : <p className="text-center text-sm text-muted-foreground">{snapshot.players.find((player) => player.id === snapshot.setterPlayerId)?.name} 正在选择角色</p>}
    <CancelRound snapshot={snapshot} playerId={privateState.playerId} />
  </div>;
}

function CCBGuessing({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const me = snapshot.players.find((player) => player.id === privateState.playerId);
  const [surrenderOpen, setSurrenderOpen] = useState(false);
  const [image, setImage] = useState<{ level: number; dataUrl: string } | null>(null);
  const origin = useOriginTracker();
  const { run, busy } = useCCBAction();
  const waitingSync = snapshot.settings.syncMode && me?.syncCompleted && me.status === "playing";
  // 出题人、其观战队友与中途加入者在服务端都记为观战，次数对他们没有意义。
  const standing = !me || me.membership === "spectator" ? "旁观中"
    : snapshot.setterPlayerId === me.id ? "你是本局出题人"
      : me.status === "observing" ? "本局观战"
        : `已用 ${me.attempts} / ${snapshot.settings.maxAttempts} 次${me.team !== null ? ` · 第 ${me.team} 队共享` : ""}`;
  return <div className="space-y-5">
    <PhaseHeader icon={Search} title={privateState.canGuess ? "猜猜是哪位角色" : "本局进行中"} />
    <div className="flex justify-center"><Countdown deadline={privateState.deadlineAt} /></div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground"><span>{standing}</span>{snapshot.settings.syncMode ? <span>同步第 {snapshot.syncRound} 轮</span> : null}</div>
    {privateState.answer ? <><p className="text-xs text-muted-foreground">答案仅对当前观战或出题视角公开</p><CCBAnswerCard answer={privateState.answer} /></> : null}
    {waitingSync ? <p role="status" className="rounded-md bg-muted p-3 text-sm">本轮已完成，等待其他玩家</p> : null}
    {privateState.canGuess ? <CCBSearch allowSubjects={snapshot.settings.subjectSearch} bannedIds={privateState.bannedCharacterIds} disabled={busy} onSelect={async (character) => { await run("ccb.game.guess", { characterId: character.id }); }} /> : !privateState.answer && !waitingSync ? <p role="status" className="text-sm text-muted-foreground">本局已结束行动，等待结算</p> : null}
    {privateState.hints.length ? <div className="space-y-2 rounded-md bg-muted p-3">{privateState.hints.map((hint, index) => <p key={index} className="text-sm">提示 {index + 1}：{hint}</p>)}</div> : null}
    {privateState.imageHintAvailable ? <div className="space-y-3"><Button variant="outline" disabled={busy} onClick={async () => { const result = await run("ccb.game.imageHint", {}); if (result) setImage({ dataUrl: result.dataUrl, level: privateState.imageHintLevel }); }}><Image />{image ? "更新图片提示" : "查看图片提示"}</Button>{image ? <img src={image.dataUrl} alt={`第 ${image.level} 级图片提示`} className="max-h-48 max-w-full rounded-md object-contain" /> : null}</div> : null}
    <CCBFeedbackTable guesses={privateState.guesses} />
    <div className="flex justify-end gap-2"><CancelRound snapshot={snapshot} playerId={privateState.playerId} />{privateState.canSurrender ? <Button variant="outline" disabled={busy} onClick={(event) => { origin.capture(event); setSurrenderOpen(true); }}><Flag />放弃本局</Button> : null}</div>
    <Dialog open={surrenderOpen} onOpenChange={setSurrenderOpen} origin={origin.origin}><DialogContent><DialogHeader><DialogTitle>放弃本局</DialogTitle><DialogDescription>确认后本局无法继续猜测，组队时会影响整个队伍。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setSurrenderOpen(false)}>继续猜测</Button><Button variant="destructive" loading={busy} onClick={async () => { if (await run("ccb.game.surrender", {})) setSurrenderOpen(false); }}>确认放弃</Button></DialogFooter></DialogContent></Dialog>
  </div>;
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

function CCBSettlement({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const summary = snapshot.roundSummary!;
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const { run, busy } = useCCBAction();
  return <div className="space-y-5"><PhaseHeader icon={Trophy} title="本局揭晓" /><CCBAnswerCard answer={summary.answer} sealed />
    <CCBScoreTable scores={summary.scores} guesses={summary.guesses} />
    <CCBFeedbackTable guesses={summary.guesses} />
    {isHost && snapshot.source === "original" ? <CCBSetterPicker snapshot={snapshot} privateState={privateState} /> : null}
    {isHost ? <Button className="w-full" disabled={busy} loading={busy} onClick={() => void run("ccb.game.next", {})}><RotateCcw />{snapshot.source === "original" ? "开始下一局" : "返回等待房间"}</Button> : <p className="text-center text-sm text-muted-foreground">等待房主开始下一局</p>}
  </div>;
}
