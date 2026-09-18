import { useEffect, useState } from "react";
import { Clock, Flag, Image, Loader2, PenLine, RotateCcw, Search } from "lucide-react";
import type { CCBCharacterSummary, CCBPrivateState, CCBRoomSnapshot } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { useOriginTracker } from "@/hooks/UseOriginTracker";
import { useCCBAction } from "@/hooks/UseCCBAction";
import { CCBSearch } from "./CCBSearch";
import { CCBAnswerCard } from "./CCBAnswerCard";
import { CCBFeedbackTable } from "./CCBFeedbackTable";
import { CCBWaiting } from "./CCBWaiting";
import { CCBSetterPicker } from "./CCBSetterPicker";

function Countdown({ deadline }: { deadline: number | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!deadline) return; const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, [deadline]);
  if (!deadline) return null;
  return <span className="inline-flex items-center gap-1 font-mono text-sm" aria-label="剩余时间"><Clock className="h-4 w-4" />{Math.max(0, Math.ceil((deadline - now) / 1000))} 秒</span>;
}

export function CCBGameArea({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  if (snapshot.phase === "waiting") return <CCBWaiting key={`${snapshot.source}:${snapshot.roomId}:${snapshot.roundNumber}`} snapshot={snapshot} privateState={privateState} />;
  if (snapshot.phase === "settled" && snapshot.roundSummary) return <CCBSettlement snapshot={snapshot} privateState={privateState} />;
  if (snapshot.phase === "answering") return <CCBSetter key={snapshot.roundNumber} snapshot={snapshot} privateState={privateState} />;
  if (snapshot.phase === "preparing") return <div className="m-auto space-y-4 p-6 text-center"><PhaseHeader icon={Loader2} title="正在准备题目" /><p className="text-sm text-muted-foreground">题目就绪后会自动开始</p><Countdown deadline={snapshot.phaseDeadlineAt} /><CancelRound snapshot={snapshot} playerId={privateState.playerId} /></div>;
  return <CCBGuessing key={snapshot.roundNumber} snapshot={snapshot} privateState={privateState} />;
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
  return <div className="mx-auto w-full max-w-2xl space-y-5 p-5 md:p-8">
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
  return <div className="space-y-5 p-4 md:p-6">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-lg font-semibold"><Search className="h-5 w-5" />{privateState.canGuess ? "猜猜是哪位角色" : "本局进行中"}</h2><Countdown deadline={privateState.deadlineAt} /></div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground"><span>已用 {me?.attempts ?? 0} / {snapshot.settings.maxAttempts} 次{me?.team !== null && me?.team !== undefined ? ` · 第 ${me.team} 队共享` : ""}</span>{snapshot.settings.syncMode ? <span>同步第 {snapshot.syncRound} 轮</span> : null}</div>
    {privateState.answer ? <><p className="text-xs text-muted-foreground">答案仅对当前观战或出题视角公开</p><CCBAnswerCard answer={privateState.answer} /></> : null}
    {waitingSync ? <p role="status" className="rounded-md bg-muted p-3 text-sm">本轮已完成，等待其他玩家</p> : null}
    {privateState.canGuess ? <CCBSearch allowSubjects={snapshot.settings.subjectSearch} bannedIds={privateState.bannedCharacterIds} disabled={busy} onSelect={async (character) => { await run("ccb.game.guess", { characterId: character.id }); }} /> : !privateState.answer && !waitingSync ? <p role="status" className="text-sm text-muted-foreground">本局已结束行动，等待结算</p> : null}
    {privateState.hints.length ? <div className="space-y-2 rounded-md bg-muted/50 p-3">{privateState.hints.map((hint, index) => <p key={index} className="text-sm">提示 {index + 1}：{hint}</p>)}</div> : null}
    {privateState.imageHintAvailable ? <div className="space-y-3"><Button variant="outline" disabled={busy} onClick={async () => { const result = await run("ccb.game.imageHint", {}); if (result) setImage({ dataUrl: result.dataUrl, level: privateState.imageHintLevel }); }}><Image />{image ? "更新图片提示" : "查看图片提示"}</Button>{image ? <img src={image.dataUrl} alt={`第 ${image.level} 级图片提示`} className="max-h-48 max-w-full rounded-md object-contain" /> : null}</div> : null}
    <CCBFeedbackTable guesses={privateState.guesses} />
    <div className="flex justify-end gap-2"><CancelRound snapshot={snapshot} playerId={privateState.playerId} />{privateState.canSurrender ? <Button variant="outline" disabled={busy} onClick={(event) => { origin.capture(event); setSurrenderOpen(true); }}><Flag />放弃本局</Button> : null}</div>
    <Dialog open={surrenderOpen} onOpenChange={setSurrenderOpen} origin={origin.origin}><DialogContent><DialogHeader><DialogTitle>放弃本局</DialogTitle><DialogDescription>确认后本局无法继续猜测，组队时会影响整个队伍。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setSurrenderOpen(false)}>继续猜测</Button><Button variant="destructive" loading={busy} onClick={async () => { if (await run("ccb.game.surrender", {})) setSurrenderOpen(false); }}>确认放弃</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

function CCBSettlement({ snapshot, privateState }: { snapshot: CCBRoomSnapshot; privateState: CCBPrivateState }) {
  const summary = snapshot.roundSummary!;
  const isHost = snapshot.hostPlayerId === privateState.playerId;
  const { run, busy } = useCCBAction();
  return <div className="space-y-5 p-4 md:p-6"><h2 className="text-xl font-semibold">本局揭晓</h2><CCBAnswerCard answer={summary.answer} />
    <div className="overflow-x-auto"><table className="w-full text-sm"><caption className="pb-3 text-left font-medium">本局得分</caption><thead><tr className="border-b text-muted-foreground"><th className="py-2 text-left">玩家</th><th className="px-3 text-right">名次</th><th className="px-3 text-right">得分</th><th className="py-2 text-left">得分明细</th></tr></thead><tbody>{summary.scores.map((score) => <tr key={score.playerId} className="border-b"><th className="py-3 text-left font-normal">{score.playerName}</th><td className="px-3 text-right tabular-nums">{score.rank ?? "—"}</td><td className="px-3 text-right tabular-nums">{score.score > 0 ? "+" : ""}{score.score}</td><td className="py-3 text-xs text-muted-foreground">{score.reason}<span className="block">基础 {score.base} · 首猜 {score.firstGuess} · 快速 {score.quickGuess} · 作品 {score.partial} · 出题 {score.setter}</span></td></tr>)}</tbody></table></div>
    <CCBFeedbackTable guesses={summary.guesses} />
    {isHost && snapshot.source === "original" ? <CCBSetterPicker snapshot={snapshot} privateState={privateState} /> : null}
    {isHost ? <Button className="w-full" disabled={busy} loading={busy} onClick={() => void run("ccb.game.next", {})}><RotateCcw />{snapshot.source === "original" ? "开始下一局" : "返回等待房间"}</Button> : <p className="text-center text-sm text-muted-foreground">等待房主开始下一局</p>}
  </div>;
}
