import { AnimatePresence, motion } from "framer-motion";
import {
  AudioLines,
  Check,
  CircleAlert,
  CircleSlash,
  Eye,
  Flag,
  Headphones,
  Play,
  RotateCcw,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { SongLyricPlayer } from "@/components/songuessr/lyrics/SongLyricPlayer";
import { AttemptList } from "@/components/songuessr/SongAttemptList";
import {
  AnimeAutoFilterSummary,
  SongAutoFilterSummary,
} from "@/components/songuessr/settings/SongSettingsPanels";
import { listItem, readoutSwap, receiptCard, receiptMarkFollow } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import type { SongGameAreaProps } from "./SongGameAreaProps";
import { GuessBar } from "./SongGuessBar";
import type {
  SonGuessrPlayerView,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
} from "@bakagame/shared";

/** 当前回合快照：`GameStage` 只在 `playing` 且回合存在时才进入作答阶段组件。 */
type Round = NonNullable<SonGuessrRoomSnapshot["currentRound"]>;

/** 作答阶段各组件共用的入参：整包区域属性加上已确认存在的当前回合。 */
type PlayingPhaseProps = SongGameAreaProps & { round: Round };

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
function AudioCueControl({
  audioStatus,
  audioPlaybackState,
  onPlayAudio,
  onRetryAudio,
}: Pick<SongGameAreaProps, "audioStatus" | "audioPlaybackState" | "onPlayAudio" | "onRetryAudio">) {
  const cue: AudioCue = audioStatus === "ready" ? audioPlaybackState : audioStatus;
  return (
    <div className="relative flex min-h-8 shrink-0 items-center justify-end">
      <span role="status" className="sr-only">
        {AUDIO_CUE_STATUS[cue]}
      </span>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={cue}
          variants={readoutSwap}
          initial="initial"
          animate="animate"
          exit="exit"
          className="flex"
        >
          {cue === "loading" ? (
            <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center">
              <Spinner className="text-primary" />
            </span>
          ) : cue === "error" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onRetryAudio}
              data-agent-control="song.audio.retry"
            >
              <CircleAlert className="text-destructive" aria-hidden="true" />
              加载失败，重试
            </Button>
          ) : cue === "idle" ? (
            <Button size="sm" onClick={onPlayAudio} data-agent-control="song.audio.play">
              <Play aria-hidden="true" />
              播放片段
            </Button>
          ) : cue === "playing" ? (
            <span
              aria-hidden="true"
              className="flex h-8 w-8 items-center justify-center text-primary"
            >
              <AudioLines className="h-4 w-4" />
            </span>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onPlayAudio}
              aria-label="重播音频"
              data-agent-control="song.audio.play"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** 本人在本轮的作答进度：还能猜、音频未就绪、猜中、队友猜中、投降、次数用尽。 */
type GuessStage = "guessing" | "preparing" | "correct" | "teamCorrect" | "gaveUp" | "exhausted";

function resolveGuessStage(
  privateState: SonGuessrPrivateState,
  me?: SonGuessrPlayerView
): GuessStage {
  if (privateState.canGuess || privateState.canGiveUp) return "guessing";
  const mine = privateState.visibleAttempts.filter(
    (attempt) => attempt.playerId === privateState.playerId
  );
  if (me?.roundStatus === "teamCorrect") return "teamCorrect";
  // 组队时投降由任一队员发起、记在发起者名下，全队共享结果；可见记录只含本人与队友
  if (privateState.visibleAttempts.some((attempt) => attempt.result === "gaveUp")) return "gaveUp";
  if (me?.roundStatus === "correct" || mine.some((attempt) => attempt.result === "correct"))
    return "correct";
  if (privateState.remainingGuesses > 0 && me?.roundStatus !== "finished") return "preparing";
  return "exhausted";
}

const RECEIPTS: Record<
  Exclude<GuessStage, "guessing" | "preparing">,
  { icon: LucideIcon; tone: string; mark: string; text: string }
> = {
  correct: {
    icon: Check,
    tone: "border-success/40 bg-success/10 text-success",
    mark: "text-success",
    text: "猜中了",
  },
  teamCorrect: {
    icon: Users,
    tone: "border-success/40 bg-success/10 text-success",
    mark: "text-success",
    text: "队友已猜中",
  },
  gaveUp: {
    icon: Flag,
    tone: "border-dashed bg-muted/40 text-muted-foreground",
    mark: "text-muted-foreground",
    text: "你已放弃本回合",
  },
  exhausted: {
    icon: CircleSlash,
    tone: "border-dashed bg-muted/40 text-muted-foreground",
    mark: "text-muted-foreground",
    text: "猜测次数已用完",
  },
};

/** 作答结束的回执：卡片回弹落位，图标晚一拍落下；猜中着成功色，投降与用尽取中性同款。 */
function GuessReceipt({ stage, solo }: { stage: keyof typeof RECEIPTS; solo: boolean }) {
  const { icon: Icon, tone, mark, text } = RECEIPTS[stage];
  return (
    <motion.div
      {...receiptCard}
      className={cn(
        "flex items-center justify-center gap-2 rounded-md border px-4 py-3 text-sm",
        tone
      )}
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

/** 猜测记录标题：看得到全房就用全房，混进队友的用本队，否则只是我的。 */
const attemptListTitle = (canObserveAllAttempts: boolean, teamAttempts: boolean): string =>
  canObserveAllAttempts ? "全房猜测" : teamAttempts ? "本队猜测" : "我的猜测";

/** 我自己已经猜过的条目 id，供答题框把它们标成已选。 */
const myGuessedIds = (privateState: SonGuessrPrivateState): string[] =>
  privateState.visibleAttempts
    .filter((attempt) => attempt.playerId === privateState.playerId)
    .flatMap((attempt) => attempt.guessedAnime?.id ?? attempt.guessedSong?.id ?? []);

/** 片段展示区：开歌词挂歌词播放器，关掉后给同一外壳的提示。 */
function ClipArea({
  snapshot,
  round,
  audioRef,
  audioPlaybackState,
  audioStatus,
}: PlayingPhaseProps) {
  if (!snapshot.settings.showLyrics) {
    // 与歌词框（SongLyricPlayer 的无歌词态）同一外壳
    return (
      <p className="flex h-24 items-center justify-center rounded-md bg-background p-3 text-center text-sm text-muted-foreground sm:h-28 sm:p-4">
        本房间已关闭歌词提示，请根据音乐进行猜测
      </p>
    );
  }
  return (
    <SongLyricPlayer
      lines={round.lyricClip?.lines ?? []}
      clipStartTime={round.lyricClip?.startTime}
      audioRef={audioRef}
      audioPlaybackState={audioPlaybackState}
      audioStatus={audioStatus}
    />
  );
}

/** 已提交答案的本轮回执：猜番显示番名，猜曲显示歌名与歌手。 */
function RoundAnswerNotice({
  anime,
  privateState,
}: {
  anime: boolean;
  privateState: SonGuessrPrivateState;
}) {
  if (anime && privateState.submittedAnime) {
    return (
      <div className="break-words rounded-md border border-primary/40 bg-primary/5 px-4 py-3 text-sm">
        本轮答案：
        <strong>{privateState.submittedAnime.nameCn || privateState.submittedAnime.name}</strong>
      </div>
    );
  }
  if (!privateState.submittedSong) return null;
  return (
    <div className="break-words rounded-md border border-primary/40 bg-primary/5 px-4 py-3 text-sm">
      本轮答案：<strong>{privateState.submittedSong.title}</strong> ·{" "}
      {privateState.submittedSong.artist}
    </div>
  );
}

/**
 * 旁观与队友观战的说明：与投降、用尽回执同一套中性虚线框加图标，
 * 不再是一行夹在答案条与猜测表之间、看不出归属的裸灰字。
 */
function ObserverNotice({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <p
      role="status"
      className="flex items-center justify-center gap-2 rounded-md border border-dashed bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {text}
    </p>
  );
}

/** 作答区：旁观与队友观战各一条提示，出题人答完后不再出控件，其余按 stage 交叉换入。 */
function AttemptArea({ props, stage }: { props: PlayingPhaseProps; stage: GuessStage }) {
  const { snapshot, privateState, me } = props;

  if (me?.membership === "spectator") {
    return <ObserverNotice icon={Eye} text="你正在旁观本轮游戏" />;
  }
  if (privateState.teamObserver) {
    return <ObserverNotice icon={Users} text="队友出题，你本局观战" />;
  }
  if (privateState.isSubmitter && stage !== "guessing") return null;

  return (
    // 作答的几种状态在同一处交叉：旧的抽出文档流淡去，新的同时落位
    <AnimatePresence initial={false} mode="popLayout">
      {stage === "guessing" ? (
        <GuessBar key="guessing" {...props} guessedIds={myGuessedIds(privateState)} />
      ) : stage === "preparing" ? (
        <motion.p
          key="preparing"
          variants={listItem}
          initial="initial"
          animate="animate"
          exit="exit"
          role="status"
          className="text-center text-sm text-muted-foreground"
        >
          音频准备中，请稍候…
        </motion.p>
      ) : (
        // 入场交给回执卡自己的回弹，外层只负责退场
        <motion.div key={stage} variants={listItem} exit="exit" role="status">
          <GuessReceipt stage={stage} solo={snapshot.solo} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** 听歌作答阶段：片段、本轮答案、作答控件与猜测记录。 */
export function SongPlayingPhase(props: PlayingPhaseProps) {
  const {
    snapshot,
    privateState,
    me,
    audioStatus,
    audioPlaybackState,
    round,
    onPlayAudio,
    onRetryAudio,
  } = props;
  const anime = snapshot.settings.questionType === "anime";
  const canObserveAllAttempts =
    privateState.isSubmitter || privateState.teamObserver || me?.membership === "spectator";
  // 组队时可见记录里混着队友的猜测，标题与每行都写明是谁猜的
  const teamAttempts =
    !canObserveAllAttempts &&
    privateState.visibleAttempts.some((attempt) => attempt.playerId !== privateState.playerId);
  const hasLyrics = (round.lyricClip?.lines?.length ?? 0) > 0;
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
          anime ? (
            <AnimeAutoFilterSummary snapshot={snapshot} />
          ) : (
            <SongAutoFilterSummary snapshot={snapshot} />
          )
        ) : null}
        <ClipArea {...props} />
        <RoundAnswerNotice anime={anime} privateState={privateState} />
      </section>
      <AttemptArea props={props} stage={stage} />
      <AttemptList
        attempts={privateState.visibleAttempts}
        title={attemptListTitle(canObserveAllAttempts, teamAttempts)}
        showPlayerName={canObserveAllAttempts || teamAttempts}
      />
    </div>
  );
}
