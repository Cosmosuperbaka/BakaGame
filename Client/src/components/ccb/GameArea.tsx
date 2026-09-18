import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Flag, Play, RotateCcw, Settings, Square, Timer } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CharacterSearch } from "@/components/ccb/CharacterSearch";
import { GuessTable } from "@/components/ccb/GuessTable";
import { useCCBStore } from "@/stores/UseCCBStore";
import { cn } from "@/lib/Utils";
import type { CCBCharacterSearchResult, CCBPhase } from "@/types";

/** 长任务（出题要跑两级采样）用无限超时，靠 `requestSync` 之外的状态广播兜底。 */
const LONG_TASK_TIMEOUT = 0;

const PHASE_LABEL: Record<CCBPhase, string> = {
  waiting: "等待开始",
  answering: "出题中",
  guessing: "猜测中",
  settled: "本局结束",
};

const formatRemaining = (milliseconds: number): string => {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

interface CCBGameAreaProps {
  botPending: boolean;
  onToggleReady: () => Promise<void>;
  onBots: (add: boolean) => Promise<void>;
  onOpenSettings: () => void;
}

/**
 * 房间操作区：按阶段分派视图。
 *
 * 数据一律取自 store（会话单例），页面只负责房间外壳（顶栏 / 玩家栏 / 聊天栏）。
 * **能力位一律读 `privateState`**，不自己推算「能不能猜」——那是服务端的权威判断。
 */
export function CCBGameArea({
  botPending,
  onToggleReady,
  onBots,
  onOpenSettings,
}: CCBGameAreaProps) {
  const snapshot = useCCBStore((state) => state.snapshot);
  const privateState = useCCBStore((state) => state.privateState);
  const sendCommand = useCCBStore((state) => state.sendCommand);
  const setNotice = useCCBStore((state) => state.setNotice);
  const [pending, setPending] = useState(false);
  const [tick, setTick] = useState(() => Date.now());

  const deadline = snapshot?.guessDeadlineAt;
  const countingDown = snapshot?.phase === "guessing" && deadline !== undefined;

  useEffect(() => {
    if (!countingDown) return;
    const timer = setInterval(() => setTick(Date.now()), 500);
    return () => clearInterval(timer);
  }, [countingDown]);

  const run = useCallback(
    async (type: string, payload?: Record<string, unknown>, timeout?: number) => {
      setPending(true);
      try {
        await sendCommand(type, payload, timeout === undefined ? undefined : { timeout });
      } catch (error) {
        setNotice((error as { message: string }).message, "error");
      } finally {
        setPending(false);
      }
    },
    [sendCommand, setNotice],
  );

  const me = useMemo(
    () => snapshot?.players.find((player) => player.id === privateState?.playerId),
    [privateState?.playerId, snapshot?.players],
  );

  // `?? []` 每次渲染都会造新数组，会让下面的 useMemo 失效；先自己 memo 住。
  const guesses = useMemo(() => privateState?.ownGuesses ?? [], [privateState?.ownGuesses]);
  const pickedIds = useMemo(
    () => new Set(guesses.map((guess) => guess.characterId)),
    [guesses],
  );

  // 同步模式的「本轮参战玩家」口径与服务端一致：正式、非人机、非出题人。
  // 直接数「还没完成的人」而不是「已完成 X / 共 Y」，这样中途有人出局也不会出现 X > Y。
  const syncPending = useMemo(() => {
    const progress = snapshot?.syncProgress;
    if (!progress) return 0;
    const completed = new Set(progress.completedPlayerIds);
    return (snapshot?.players ?? []).filter(
      (player) =>
        player.membership === "active" &&
        !player.isBot &&
        player.id !== snapshot?.answerSetterPlayerId &&
        !completed.has(player.id),
    ).length;
  }, [snapshot]);

  const nonstopRemaining = useMemo(
    () =>
      (snapshot?.players ?? []).filter(
        (player) =>
          player.membership === "active" &&
          !player.isBot &&
          player.id !== snapshot?.answerSetterPlayerId &&
          !player.finished,
      ).length,
    [snapshot],
  );

  const handleGuess = useCallback(
    (character: CCBCharacterSearchResult) => {
      void run("ccb.game.guess", { characterId: character.id });
    },
    [run],
  );

  if (!snapshot) return null;

  const isSpectator = me?.membership === "spectator";
  const phase = snapshot.phase;
  const inRound = phase === "guessing" || phase === "settled";
  const remaining =
    countingDown && deadline !== undefined ? Math.max(0, deadline - tick) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶栏：阶段 / 局数 / 倒计时 / 剩余次数 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="font-normal">
          {PHASE_LABEL[phase]}
        </Badge>
        {inRound ? <span>第 {snapshot.roundNumber} 局</span> : null}
        {inRound && snapshot.syncProgress ? (
          <span>
            第 {snapshot.syncProgress.round} 轮 ·{" "}
            {syncPending === 0 ? "本轮已完成" : `${syncPending} 人未完成`}
          </span>
        ) : null}
        {inRound && snapshot.nonstopWinnerIds ? (
          <span>
            已猜对 {snapshot.nonstopWinnerIds.length} 人 · 剩 {nonstopRemaining} 人
          </span>
        ) : null}
        {remaining !== undefined ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 font-mono",
              remaining <= 10_000 && "text-destructive",
            )}
          >
            <Timer className="h-3.5 w-3.5" />
            {formatRemaining(remaining)}
          </span>
        ) : null}
        {privateState && me?.membership === "active" ? (
          <span>剩余次数 {privateState.remainingGuesses}</span>
        ) : null}
        {isSpectator ? <span>旁观中</span> : null}
        {snapshot.bannedTags && snapshot.bannedTags.length > 0 ? (
          <span title="被他人揭示过的共享标签，对你是 ???">标签 BP {snapshot.bannedTags.length}</span>
        ) : null}
      </div>

      {/* 正文 */}
      {inRound ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          {phase === "settled" && snapshot.answer ? (
            <div className="flex shrink-0 items-center gap-3 rounded-md border bg-card px-3 py-2">
              {snapshot.answer.imageUrl ? (
                <img
                  src={snapshot.answer.imageUrl}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded object-cover"
                />
              ) : null}
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">答案</p>
                <p className="truncate font-medium">
                  {snapshot.answer.nameCn || snapshot.answer.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">{snapshot.answer.name}</p>
              </div>
            </div>
          ) : null}

          {phase === "guessing" && !isSpectator && privateState?.canGuess ? (
            <div className="shrink-0">
              <CharacterSearch pickedIds={pickedIds} disabled={pending} onSelect={handleGuess} />
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden rounded-md border bg-card">
            <GuessTable guesses={guesses} className="h-full" />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-4 py-8">
          <div className="flex flex-col items-center gap-1 text-center">
            <span className="font-mono text-3xl font-semibold tracking-[0.3em] text-foreground/80">
              {snapshot.roomId}
            </span>
            <span className="text-sm text-muted-foreground">
              {isSpectator
                ? "你正在旁观本房间"
                : me?.isHost
                  ? "等待你开始本局"
                  : "等待房主开始本局"}
            </span>
          </div>
          {isSpectator ? null : (
            <Button
              variant={me?.isReady ? "secondary" : "default"}
              onClick={() => void onToggleReady()}
            >
              {me?.isReady ? "取消准备" : "准备"}
            </Button>
          )}
        </div>
      )}

      {/* 操作行 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2">
        {me?.isHost ? (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onOpenSettings}>
            <Settings className="h-3.5 w-3.5" />
            房间设置
          </Button>
        ) : null}
        {me?.isHost && snapshot.testMode ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={botPending}
              onClick={() => void onBots(true)}
            >
              <Bot className="h-3.5 w-3.5" />
              增加人机
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={botPending}
              onClick={() => void onBots(false)}
            >
              移除人机
            </Button>
          </>
        ) : null}

        <span className="flex-1" />

        {phase === "guessing" && privateState?.canSurrender ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={pending}
            onClick={() => void run("ccb.game.surrender")}
          >
            <Flag className="h-3.5 w-3.5" />
            投降
          </Button>
        ) : null}

        {phase === "settled" && privateState?.canStartRound ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={pending}
              onClick={() => void run("ccb.game.finish")}
            >
              <Square className="h-3.5 w-3.5" />
              结束对局
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={pending}
              onClick={() => void run("ccb.game.nextRound", undefined, LONG_TASK_TIMEOUT)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              下一局
            </Button>
          </>
        ) : null}

        {phase === "waiting" && privateState?.canStartRound ? (
          <Button
            size="sm"
            className="gap-1.5"
            disabled={pending}
            onClick={() => void run("ccb.game.start", undefined, LONG_TASK_TIMEOUT)}
          >
            <Play className="h-3.5 w-3.5" />
            开始游戏
          </Button>
        ) : null}

        {phase === "waiting" && !privateState?.canStartRound && !isSpectator ? (
          <span className="text-xs text-muted-foreground">等待房主开始</span>
        ) : null}
      </div>
    </div>
  );
}
