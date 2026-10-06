import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Check,
  CircleAlert,
  CircleSlash,
  Clock3,
  Equal,
  Eye,
  Film,
  Flag,
  Headphones,
  Minus,
  Music2,
  Play,
  RotateCcw,
  UserCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { useSecondsLeft } from "@/hooks/UseSecondsLeft";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { Spinner } from "@/components/ui/Spinner";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { CountdownBadge } from "@/components/common/room/CountdownBadge";
import { PhaseStage } from "@/components/common/room/PhaseStage";
import { SongWaitingPhase } from "@/components/songuessr/phases/SongWaitingPhase";
import { SongRoundResultPhase } from "@/components/songuessr/phases/SongRoundResultPhase";
import { SongTestController } from "@/components/songuessr/layout/SongTestController";
import { AnimeSearch, SongSearch } from "@/components/songuessr/SongSearch";
import { SongLyricPlayer } from "@/components/songuessr/lyrics/SongLyricPlayer";
import { AnimeAutoFilterSummary, SongAutoFilterSummary } from "@/components/songuessr/settings/SongSettingsPanels";
import { CandidateGrid, SectionHeader } from "@/components/common/CandidateGrid";
import { listItem, readoutSwap, receiptCard, receiptMarkFollow } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import type {
  SongGuessAttempt,
  SongGuessDirection,
  SonGuessrPlayerView,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
} from "@/types";

/** 方向箭头指向答案：higher 即答案比这次猜的更大（年份更晚、热度更高）。 */
const DIRECTION_ICON: Record<SongGuessDirection, LucideIcon> = {
  higher: ArrowUp,
  lower: ArrowDown,
  equal: Equal,
  unknown: Minus,
};
const YEAR_HINT: Record<SongGuessDirection, string> = {
  higher: "答案更晚",
  lower: "答案更早",
  equal: "年份相同",
  unknown: "无法比较",
};
const POPULARITY_HINT: Record<SongGuessDirection, string> = {
  higher: "答案热度更高",
  lower: "答案热度更低",
  equal: "热度相同",
  unknown: "无法比较",
};

/**
 * 一枚反馈徽章：取值与指向答案的图标同处一枚，命中（相同）用 `matched`，其余 `muted`。
 * 图标对读屏隐藏，含义由紧随其后的视觉隐藏文字读出，鼠标悬停时 `title` 给出同一句。
 */
function FeedbackBadge({ matched, icon: Icon, hint, children }: {
  matched: boolean;
  icon: LucideIcon;
  hint: string;
  children: ReactNode;
}) {
  return (
    <Badge variant={matched ? "matched" : "muted"} size="sm" className="tabular-nums" title={hint}>
      {children}
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">，{hint}</span>
    </Badge>
  );
}

/** 每条猜测的结果图标；可读名挂在图标上（`role="img"`），不另占一段文字。 */
const RESULT_MARK: Record<SongGuessAttempt["result"], { icon: LucideIcon; tone: string; label: string }> = {
  correct: { icon: Check, tone: "text-success", label: "猜对" },
  timeout: { icon: Clock3, tone: "text-warning", label: "超时" },
  gaveUp: { icon: Flag, tone: "text-muted-foreground", label: "投降" },
  wrong: { icon: X, tone: "text-destructive", label: "猜错" },
};

function attemptText(attempt: SongGuessAttempt) {
  if (attempt.guessedAnime) return attempt.guessedAnime.nameCn || attempt.guessedAnime.name;
  if (attempt.guessedSong) return `${attempt.guessedSong.title} · ${attempt.guessedSong.artist}`;
  return attempt.result === "gaveUp" ? "投降" : "超时";
}

function AttemptFeedback({ feedback }: { feedback: NonNullable<SongGuessAttempt["feedback"]> }) {
  const year = feedback.releaseYearDirection;
  const popularity = feedback.popularityDirection;
  return (
    <div className="flex flex-wrap gap-1">
      <FeedbackBadge matched={year === "equal"} icon={DIRECTION_ICON[year]} hint={YEAR_HINT[year]}>
        年份 {feedback.releaseYear ?? "未知"}
      </FeedbackBadge>
      <FeedbackBadge matched={popularity === "equal"} icon={DIRECTION_ICON[popularity]} hint={POPULARITY_HINT[popularity]}>
        热度 {feedback.popularity ?? "未知"}
      </FeedbackBadge>
      {feedback.languageMatch !== undefined ? (
        <FeedbackBadge
          matched={feedback.languageMatch}
          icon={feedback.languageMatch ? Check : X}
          hint={feedback.languageMatch ? "语种相同" : "语种不同"}
        >
          语种
        </FeedbackBadge>
      ) : null}
      {/* 共同标签本身就是与答案重合的线索 */}
      {feedback.sharedTags.map((tag) => <Badge key={tag} variant="matched" size="sm">{tag}</Badge>)}
    </div>
  );
}

/**
 * 猜测记录。名字在上、反馈徽章在下，名字不和徽章抢宽度，窄屏不会被挤成逐字竖排。
 * 从无到有时整块按 collapsible 撑开；之后新提交的一行以 listItem 推入，其余行按位置让开。
 */
export function AttemptList({
  attempts,
  title,
  showPlayerName = false,
}: {
  attempts: SongGuessAttempt[];
  title: string;
  showPlayerName?: boolean;
}) {
  return (
    // 外层常驻：所在 space-y 容器的间距不随有无记录跳一下，收放只交给 CollapsibleRegion。
    <div>
      <CollapsibleRegion open={attempts.length > 0}>
        <section className="overflow-hidden rounded-md border bg-panel">
          <div className="bg-muted px-4 py-2.5">
            <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
          </div>
          <AnimatePresence initial={false}>
            {attempts.map((attempt) => {
              const mark = RESULT_MARK[attempt.result];
              return (
                <motion.div
                  key={attempt.id}
                  variants={listItem}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  layout="position"
                  className="flex origin-left flex-col gap-1.5 border-t px-4 py-3"
                >
                  <div className="flex min-w-24 items-center gap-2">
                    <mark.icon role="img" aria-label={mark.label} className={cn("h-4 w-4 shrink-0", mark.tone)} />
                    <span className="min-w-0 break-words text-sm">
                      {showPlayerName ? `${attempt.playerName}：` : ""}
                      {attemptText(attempt)}
                    </span>
                  </div>
                  {/* 徽章行与名字左缘对齐（让过 h-4 图标与 gap-2） */}
                  {attempt.feedback ? <div className="pl-6"><AttemptFeedback feedback={attempt.feedback} /></div> : null}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </section>
      </CollapsibleRegion>
    </div>
  );
}

export interface SongGameAreaProps {
  snapshot: SonGuessrRoomSnapshot;
  privateState: SonGuessrPrivateState;
  me?: SonGuessrPlayerView;
  isHost: boolean;
  guessDeadlineAt?: number | null;
  volume: number;
  onVolumeChange: (value: number) => void;
  audioStatus: "loading" | "ready" | "error";
  audioPlaybackState: "idle" | "playing" | "completed";
  onPlayAudio: () => void;
  onRetryAudio: () => void;
  onSelectSearchSong: (songId: string, mode: "submit" | "guess", extraId?: string) => Promise<void>;
  run: (type: string, payload?: Record<string, unknown>, success?: string) => Promise<void>;
  isPending?: (type: string) => boolean;
  audioRef?: React.RefObject<HTMLAudioElement | null>;
}

export function SongGuessCountdown({ deadlineAt }: { deadlineAt?: number | null }) {
  const secondsLeft = useSecondsLeft(deadlineAt);
  return <CountdownBadge secondsLeft={secondsLeft} />;
}

type AudioCue = "loading" | "error" | "idle" | "playing" | "completed";

const AUDIO_CUE_STATUS: Record<AudioCue, string> = {
  loading: "音频加载中",
  error: "音频加载失败",
  idle: "等待播放",
  playing: "正在播放",
  completed: "播放结束",
};

/**
 * 歌词卡右上角的音频状态。失败与待播放（自动播放被浏览器拦下）要玩家动手，给带文字的按钮；
 * 加载中、播放中只是状态，播放中用声波图标而不是转圈，免得读成还在加载。
 * 各态以 readoutSwap 交替，状态变化由视觉隐藏的 status 区读出。
 */
function AudioCueControl({ audioStatus, audioPlaybackState, onPlayAudio, onRetryAudio }: Pick<
  SongGameAreaProps, "audioStatus" | "audioPlaybackState" | "onPlayAudio" | "onRetryAudio"
>) {
  const cue: AudioCue = audioStatus === "ready" ? audioPlaybackState : audioStatus;
  return (
    <div className="relative flex min-h-8 shrink-0 items-center justify-end">
      <span role="status" className="sr-only">{AUDIO_CUE_STATUS[cue]}</span>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div key={cue} variants={readoutSwap} initial="initial" animate="animate" exit="exit" className="flex">
          {cue === "loading" ? (
            <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center">
              <Spinner className="text-primary" />
            </span>
          ) : cue === "error" ? (
            <Button variant="outline" size="sm" onClick={onRetryAudio}>
              <CircleAlert className="text-destructive" aria-hidden="true" />加载失败，重试
            </Button>
          ) : cue === "idle" ? (
            <Button size="sm" onClick={onPlayAudio}>
              <Play aria-hidden="true" />播放片段
            </Button>
          ) : cue === "playing" ? (
            <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center text-primary">
              <AudioLines className="h-4 w-4" />
            </span>
          ) : (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onPlayAudio} aria-label="重播音频">
              <RotateCcw className="h-4 w-4" />
            </Button>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** 本人在本轮的作答进度：还能猜、音频未就绪、猜中、投降、次数用尽。 */
type GuessStage = "guessing" | "preparing" | "correct" | "gaveUp" | "exhausted";

function resolveGuessStage(privateState: SonGuessrPrivateState, me?: SonGuessrPlayerView): GuessStage {
  if (privateState.canGuess || privateState.canGiveUp) return "guessing";
  const mine = privateState.visibleAttempts.filter((attempt) => attempt.playerId === privateState.playerId);
  if (mine.some((attempt) => attempt.result === "gaveUp")) return "gaveUp";
  if (me?.roundStatus === "correct" || mine.some((attempt) => attempt.result === "correct")) return "correct";
  if (privateState.remainingGuesses > 0 && me?.roundStatus !== "finished") return "preparing";
  return "exhausted";
}

const RECEIPTS: Record<Exclude<GuessStage, "guessing" | "preparing">, { icon: LucideIcon; tone: string; mark: string; text: string }> = {
  correct: { icon: Check, tone: "border-success/40 bg-success/10 text-success", mark: "text-success", text: "猜中了" },
  gaveUp: { icon: Flag, tone: "border-dashed bg-muted/40 text-muted-foreground", mark: "text-muted-foreground", text: "你已放弃本回合" },
  exhausted: { icon: CircleSlash, tone: "border-dashed bg-muted/40 text-muted-foreground", mark: "text-muted-foreground", text: "猜测次数已用完" },
};

/** 作答结束的回执：卡片回弹落位，图标晚一拍落下；猜中着成功色，投降与用尽取中性同款。 */
function GuessReceipt({ stage, solo }: { stage: keyof typeof RECEIPTS; solo: boolean }) {
  const { icon: Icon, tone, mark, text } = RECEIPTS[stage];
  return (
    <motion.div
      {...receiptCard}
      className={cn("flex items-center justify-center gap-2 rounded-md border px-4 py-3 text-sm", tone)}
    >
      <motion.span
        aria-hidden="true"
        className={cn("flex", mark)}
        initial={receiptMarkFollow.initial}
        animate={receiptMarkFollow.animate}
        transition={receiptMarkFollow.transition}
      >
        <Icon className="h-4 w-4" />
      </motion.span>
      {/* 单人模式下一人作答完即进入结算，不必等谁 */}
      <span>{solo ? text : `${text}，等待其他玩家`}</span>
    </motion.div>
  );
}

export function GameStage(props: SongGameAreaProps) {
  const {
    snapshot,
    privateState,
    me,
    isHost,
    audioStatus,
    audioPlaybackState,
    onPlayAudio,
    onRetryAudio,
    run,
    isPending,
    audioRef,
  } = props;

  if (snapshot.phase === "waiting") {
    return <SongWaitingPhase snapshot={snapshot} me={me} isHost={isHost} run={run} isPending={isPending} />;
  }

  if (snapshot.phase === "choosingSubmitter") {
    return <ChoosingSubmitterPhase snapshot={snapshot} isHost={isHost} run={run} isPending={isPending} />;
  }

  if (snapshot.phase === "submittingSong") {
    return <SubmittingSongPhase {...props} />;
  }

  if (snapshot.phase === "playing" && snapshot.currentRound) {
    const anime = snapshot.settings.questionType === "anime";
    const canObserveAllAttempts = privateState.isSubmitter || me?.membership === "spectator";
    const hasLyrics = (snapshot.currentRound.lyricClip?.lines?.length ?? 0) > 0;
    const stage = resolveGuessStage(privateState, me);
    return (
      <div className="relative mx-auto max-w-2xl space-y-5">
        <PhaseHeader icon={Headphones} title={anime ? "听歌猜番" : "听歌猜曲"} />
        <section className="space-y-5 rounded-md bg-muted p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold text-muted-foreground">
              {snapshot.settings.showLyrics && hasLyrics ? "歌词片段" : "音乐片段"}
            </h3>
            <AudioCueControl
              audioStatus={audioStatus}
              audioPlaybackState={audioPlaybackState}
              onPlayAudio={onPlayAudio}
              onRetryAudio={onRetryAudio}
            />
          </div>
          {snapshot.settings.questionMode === "automatic" ? (
            anime ? <AnimeAutoFilterSummary snapshot={snapshot} /> : <SongAutoFilterSummary snapshot={snapshot} />
          ) : null}
          {snapshot.settings.showLyrics ? (
            <SongLyricPlayer
              lines={snapshot.currentRound.lyricClip?.lines ?? []}
              audioRef={audioRef}
              audioPlaybackState={audioPlaybackState}
              audioStatus={audioStatus}
            />
          ) : (
            // 与歌词框（SongLyricPlayer 的无歌词态）同一外壳
            <p className="flex h-24 items-center justify-center rounded-md bg-background p-3 text-center text-sm text-muted-foreground sm:h-28 sm:p-4">
              本房间已关闭歌词提示，请根据音乐进行猜测
            </p>
          )}
          {anime && privateState.submittedAnime ? (
            <div className="break-words rounded-md border border-primary/40 bg-primary/5 px-4 py-3 text-sm">本轮答案：<strong>{privateState.submittedAnime.nameCn || privateState.submittedAnime.name}</strong></div>
          ) : privateState.submittedSong ? (
            <div className="break-words rounded-md border border-primary/40 bg-primary/5 px-4 py-3 text-sm">
              本轮答案：<strong>{privateState.submittedSong.title}</strong> · {privateState.submittedSong.artist}
            </div>
          ) : null}
        </section>
        {me?.membership === "spectator" ? (
          <p className="text-center text-sm text-muted-foreground">你正在旁观本轮游戏</p>
        ) : privateState.isSubmitter && stage !== "guessing" ? null : (
          // 作答的几种状态在同一处交叉：旧的抽出文档流淡去，新的同时落位
          <AnimatePresence initial={false} mode="popLayout">
            {stage === "guessing" ? (
              <GuessBar
                key="guessing"
                {...props}
                guessedIds={privateState.visibleAttempts
                  .filter((attempt) => attempt.playerId === privateState.playerId)
                  .flatMap((attempt) => attempt.guessedAnime?.id ?? attempt.guessedSong?.id ?? [])}
              />
            ) : stage === "preparing" ? (
              <motion.p key="preparing" variants={listItem} initial="initial" animate="animate" exit="exit" role="status" className="text-center text-sm text-muted-foreground">
                音频准备中，请稍候...
              </motion.p>
            ) : (
              // 入场交给回执卡自己的回弹，外层只负责退场
              <motion.div key={stage} variants={listItem} exit="exit" role="status">
                <GuessReceipt stage={stage} solo={snapshot.solo} />
              </motion.div>
            )}
          </AnimatePresence>
        )}
        <AttemptList
          attempts={privateState.visibleAttempts}
          title={canObserveAllAttempts ? "全房猜测" : "我的猜测"}
          showPlayerName={canObserveAllAttempts}
        />
      </div>
    );
  }

  if (snapshot.phase === "roundResult" && snapshot.roundSummary) {
    return (
      <SongRoundResultPhase
        snapshot={snapshot}
        privateState={privateState}
        me={me}
        isHost={isHost}
        run={run}
        isPending={isPending}
      />
    );
  }

  return <SongWaitingPhase snapshot={snapshot} me={me} isHost={isHost} run={run} isPending={isPending} />;
}

function ChoosingSubmitterPhase({ snapshot, isHost, run, isPending }: Pick<SongGameAreaProps, "snapshot" | "isHost" | "run" | "isPending">) {
  const activeCandidates = snapshot.players.filter(
    (player) => player.membership === "active" && player.online && !player.isBot,
  );
  const spectatorCandidates = snapshot.players.filter(
    (player) => player.membership === "spectator" && player.online && !player.isBot,
  );
  const choosing = isPending?.("song.game.chooseSubmitter") ?? false;
  const pick = (playerId: string) => void run("song.game.chooseSubmitter", { playerId });
  return (
    <div className="flex flex-col items-center gap-6">
      <PhaseHeader icon={UserCheck} title="指定出题人" />
      {isHost ? (
        <div className="w-full max-w-xl space-y-5">
          {spectatorCandidates.length > 0 ? (
            <section>
              <SectionHeader title="旁观玩家" icon={<Eye className="h-3.5 w-3.5" />} />
              <CandidateGrid candidates={spectatorCandidates} tone="recommended" nameWrap="wrap" disabled={choosing} onPick={pick} />
            </section>
          ) : null}
          <section>
            <SectionHeader title="玩家" icon={<UserCheck className="h-3.5 w-3.5" />} />
            <CandidateGrid candidates={activeCandidates} tone="default" nameWrap="wrap" disabled={choosing} onPick={pick} />
          </section>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">等待房主指定本局出题人</p>
      )}
    </div>
  );
}

function SubmittingSongPhase({ snapshot, privateState, onSelectSearchSong }: SongGameAreaProps) {
  const anime = snapshot.settings.questionType === "anime";
  const submitter = snapshot.players.find((player) => player.id === snapshot.pendingSubmitterPlayerId);
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 text-center">
      <PhaseHeader
        icon={anime ? Film : Music2}
        title={privateState.canSubmitSong ? "轮到你出题" : anime ? "等待出题人选番" : "等待出题人选歌"}
      />
      {privateState.canSubmitSong ? (
        <>
          <p className="text-sm text-muted-foreground">
            {anime
              ? "搜索一部有主题曲的番剧，再挑一首关联曲作为题目。"
              : "搜索一首可播放的网易云音乐歌曲，点一下即设为答案。"}
            歌曲信息只会在回合结束后公开。
          </p>
          {anime ? (
            <AnimeSearch
              mode="submit"
              className="w-full"
              onSelect={(subject, songId) => onSelectSearchSong(subject.id, "submit", songId)}
            />
          ) : (
            <SongSearch mode="submit" className="w-full" onSelect={(song) => onSelectSearchSong(song.id, "submit")} />
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {submitter?.name ?? "出题人"} 正在选择{anime ? "番剧" : "歌曲"}
        </p>
      )}
    </div>
  );
}

/**
 * 猜测栏：搜索框与投降按钮独立成行，放在歌词卡之下，不和歌词挤在同一块里。
 * 上方一行是剩余次数与限时；音频还没就绪时搜索框禁用，投降仍可用。
 * md 以下歌词卡就占满首屏，猜测栏贴在游戏区滚动视口的底边（区内遮罩档 `bg-panel/90 backdrop-blur-sm`），
 * 左右以负外边距铺满游戏区内边距；滚到它的原位后随内容回到流内。
 */
function GuessBar({ ref, snapshot, privateState, guessDeadlineAt, onSelectSearchSong, run, isPending, guessedIds }: SongGameAreaProps & {
  guessedIds: string[];
  ref?: React.Ref<HTMLElement>;
}) {
  const givingUp = isPending?.("song.game.giveUp") ?? false;
  const anime = snapshot.settings.questionType === "anime";
  return (
    <motion.section
      ref={ref}
      variants={listItem}
      initial="initial"
      animate="animate"
      exit="exit"
      aria-label="提交猜测"
      className="origin-left space-y-2 max-md:sticky max-md:bottom-0 max-md:z-panel max-md:-mx-6 max-md:bg-panel/90 max-md:px-6 max-md:pt-3 max-md:pb-3 max-md:backdrop-blur-sm"
    >
      <div className="flex min-h-7 items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{privateState.canGuess ? `剩余 ${privateState.remainingGuesses} 次猜测` : "音频准备中，请稍候..."}</span>
        {snapshot.settings.showGuessTimer && privateState.canGuess && privateState.guessDeadlineAt ? (
          <SongGuessCountdown deadlineAt={guessDeadlineAt} />
        ) : null}
      </div>
      <div className="flex gap-2">
        {anime ? (
          <AnimeSearch
            mode="guess"
            className="flex-1"
            disabled={!privateState.canGuess}
            guessedIds={guessedIds}
            onSelect={(subject) => onSelectSearchSong(subject.id, "guess")}
          />
        ) : (
          <SongSearch
            mode="guess"
            className="flex-1"
            disabled={!privateState.canGuess}
            guessedIds={guessedIds}
            onSelect={(song) => onSelectSearchSong(song.id, "guess")}
          />
        )}
        {privateState.canGiveUp ? (
          <Button variant="outline" className="h-10 shrink-0" loading={givingUp} onClick={() => void run("song.game.giveUp")}>
            {givingUp ? "正在放弃..." : <><Flag />投降</>}
          </Button>
        ) : null}
      </div>
    </motion.section>
  );
}

export function SongGameArea(props: SongGameAreaProps) {
  return (
    <PhaseStage
      phaseKey={props.snapshot.phase}
      reserveBottom={props.snapshot.testMode}
      overlays={props.snapshot.testMode ? <SongTestController run={props.run} snapshot={props.snapshot} isPending={props.isPending} /> : null}
    >
      <GameStage {...props} />
    </PhaseStage>
  );
}
