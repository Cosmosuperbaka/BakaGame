import { lazy, Suspense, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AudioLines,
  Check,
  CircleAlert,
  CircleSlash,
  Eye,
  Film,
  Flag,
  Headphones,
  Music2,
  Play,
  RotateCcw,
  UserCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { PhaseStage } from "@/components/common/room/PhaseStage";
import { SongWaitingPhase } from "@/components/songuessr/phases/SongWaitingPhase";
import { SongRoundResultPhase } from "@/components/songuessr/phases/SongRoundResultPhase";
import { SongTestController } from "@/components/songuessr/layout/SongTestController";
import { AnimeSearch, SongSearch } from "@/components/songuessr/SongSearch";
import { SongLyricPlayer } from "@/components/songuessr/lyrics/SongLyricPlayer";
import {
  AnimeAutoFilterSummary,
  SongAutoFilterSummary,
} from "@/components/songuessr/settings/SongSettingsPanels";
import { CandidateGrid, SectionHeader } from "@/components/common/CandidateGrid";
import { listItem, phaseSwap, readoutSwap, receiptCard, receiptMarkFollow } from "@/lib/Motion";
import { withTeamName } from "@/lib/Teams";
import { cn } from "@/lib/Utils";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { AttemptList } from "@/components/songuessr/SongAttemptList";
import type { SongGameAreaProps } from "./SongGameAreaProps";
import { GuessBar } from "./SongGuessBar";
import type {
  SongClipPreview,
  SongSearchResult,
  SonGuessrPlayerView,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
} from "@bakagame/shared";

const SongClipEditor = lazy(async () => ({
  default: (await import("@/components/songuessr/SongClipEditor")).SongClipEditor,
}));

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

export function GameStage(props: SongGameAreaProps) {
  const { snapshot, privateState, me, isHost, run, isPending } = props;

  if (snapshot.phase === "waiting") {
    return (
      <SongWaitingPhase
        snapshot={snapshot}
        me={me}
        isHost={isHost}
        submitterCandidateIds={privateState.submitterCandidateIds}
        run={run}
        isPending={isPending}
      />
    );
  }

  if (snapshot.phase === "choosingSubmitter") {
    return (
      <ChoosingSubmitterPhase
        snapshot={snapshot}
        privateState={privateState}
        isHost={isHost}
        run={run}
        isPending={isPending}
      />
    );
  }

  if (snapshot.phase === "submittingSong") {
    return <SubmittingSongPhase {...props} />;
  }

  if (snapshot.phase === "playing" && snapshot.currentRound) {
    return <SongPlayingPhase {...props} round={snapshot.currentRound} />;
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

  return (
    <SongWaitingPhase
      snapshot={snapshot}
      me={me}
      isHost={isHost}
      submitterCandidateIds={privateState.submitterCandidateIds}
      run={run}
      isPending={isPending}
    />
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
function SongPlayingPhase(props: PlayingPhaseProps) {
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

/**
 * 房主指定出题人：候选取服务端下发的 `submitterCandidateIds`（在线真人，且他出题、队友一起观战后仍留得下猜歌的人）。
 * 组队时候选名后带上队伍，并提示指定后其队友本局一起观战。
 */
function ChoosingSubmitterPhase({
  snapshot,
  privateState,
  isHost,
  run,
  isPending,
}: Pick<SongGameAreaProps, "snapshot" | "privateState" | "isHost" | "run" | "isPending">) {
  const allowed = new Set(privateState.submitterCandidateIds);
  const candidates = snapshot.players.filter((player) => allowed.has(player.id));
  const activeCandidates = candidates
    .filter((player) => player.membership === "active")
    .map(withTeamName);
  const spectatorCandidates = candidates.filter((player) => player.membership === "spectator");
  const teamed = snapshot.players.some(
    (player) => player.membership === "active" && player.team !== null
  );
  const choosing = isPending?.("song.game.chooseSubmitter") ?? false;
  const pick = (playerId: string) => void run("song.game.chooseSubmitter", { playerId });
  return (
    <div className="flex flex-col items-center gap-6">
      <PhaseHeader icon={UserCheck} title="指定出题人" />
      {snapshot.submitterPrompt ? (
        <p className="max-w-xl text-center text-sm text-muted-foreground">
          {snapshot.submitterPrompt}
        </p>
      ) : null}
      {isHost ? (
        <div className="w-full max-w-xl space-y-5">
          {spectatorCandidates.length > 0 ? (
            <section>
              <SectionHeader title="旁观玩家" icon={<Eye className="h-3.5 w-3.5" />} />
              <CandidateGrid
                candidates={spectatorCandidates}
                tone="recommended"
                nameWrap="wrap"
                disabled={choosing}
                onPick={pick}
                agentControlPrefix="song.submitter"
              />
            </section>
          ) : null}
          {activeCandidates.length > 0 ? (
            <section>
              <SectionHeader title="玩家" icon={<UserCheck className="h-3.5 w-3.5" />} />
              <CandidateGrid
                candidates={activeCandidates}
                tone="default"
                nameWrap="wrap"
                disabled={choosing}
                onPick={pick}
                agentControlPrefix="song.submitter"
              />
            </section>
          ) : null}
          {candidates.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">暂无可选出题人</p>
          ) : teamed ? (
            <p className="text-center text-xs text-muted-foreground">指定后其队友本局一起观战</p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">等待房主指定本局出题人</p>
      )}
    </div>
  );
}

const submitPrompt = (anime: boolean, customClip: boolean) => {
  if (anime) return "搜索一部有主题曲的番剧，再挑一首关联曲作为题目。";
  return customClip
    ? "搜索一首可播放的歌曲，选中后可试听并截取片段。"
    : "搜索一首可播放的歌曲，选中即出题，片段由系统随机截取。";
};

/**
 * 手动出题：先搜歌，选中后进入片段配置，再由出题人确认区间。
 *
 * 猜番仍是一步提交：番剧与关联曲由服务端匹配，没有「选歌词片段」这一层。
 */
function SubmittingSongPhase({
  snapshot,
  privateState,
  volume,
  onSelectSearchSong,
}: SongGameAreaProps) {
  const anime = snapshot.settings.questionType === "anime";
  const sendCommand = useSonGuessrStore((state) => state.sendCommand);
  const [preview, setPreview] = useState<SongClipPreview | null>(null);
  const submitter = snapshot.players.find(
    (player) => player.id === snapshot.pendingSubmitterPlayerId
  );

  const customClip = snapshot.settings.allowCustomClip !== false;

  const pickSong = async (song: SongSearchResult) => {
    if (!customClip) {
      await onSelectSearchSong(song.id, "submit", undefined, undefined, {
        sources: song.sources,
        requiresVip: song.requiresVip,
      });
      return;
    }
    const payload: { songId: string; sources?: string[]; requiresVip?: boolean } = {
      songId: song.id,
    };
    if (song.sources?.length) payload.sources = song.sources;
    if (song.requiresVip !== undefined) payload.requiresVip = song.requiresVip;
    const { song: detail } = await sendCommand(
      "song.music.detail",
      payload,
      // 与提交出题同口径：回源取音频与歌词的耗时由上游决定，不拿默认超时误报失败。
      { timeout: 0 }
    );
    setPreview(detail);
  };

  return (
    <div className="mx-auto flex w-full flex-col items-center gap-6 text-center">
      <PhaseHeader
        icon={anime ? Film : Music2}
        title={
          privateState.canSubmitSong ? "轮到你出题" : anime ? "等待出题人选番" : "等待出题人选歌"
        }
      />
      {privateState.canSubmitSong ? (
        // 搜歌表单与片段配置共用这一格：换内容时按阶段切换的前后推入语汇互为进退，
        // 宽度档也随内容走，退出的那幅不会被挤压变形。
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={preview ? "clip" : "search"}
            variants={phaseSwap}
            initial="initial"
            animate="animate"
            exit="exit"
            // gap-4：说明文字与搜索框之间留出与页面其它「说明 + 控件」相同的呼吸，原先末行贴着框沿
            className={cn(
              "flex w-full flex-col items-center gap-4",
              preview ? "max-w-2xl" : "max-w-md"
            )}
          >
            {preview ? (
              <Suspense
                fallback={
                  <div
                    role="status"
                    aria-label="正在加载片段编辑器"
                    className="flex min-h-40 items-center justify-center"
                  >
                    <Spinner className="size-6 text-primary" />
                  </div>
                }
              >
                <SongClipEditor
                  song={preview}
                  volume={volume}
                  onConfirm={(clip) =>
                    onSelectSearchSong(preview.id, "submit", undefined, clip, {
                      sources: preview.sources,
                      requiresVip: preview.requiresVip,
                    })
                  }
                  onCancel={() => setPreview(null)}
                />
              </Suspense>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {submitPrompt(anime, customClip)}
                  歌曲信息只会在回合结束后公开。
                </p>
                {anime ? (
                  <AnimeSearch
                    mode="submit"
                    className="w-full"
                    onSelect={(subject, songId) => onSelectSearchSong(subject.id, "submit", songId)}
                  />
                ) : (
                  <SongSearch mode="submit" className="w-full" onSelect={pickSong} />
                )}
              </>
            )}
          </motion.div>
        </AnimatePresence>
      ) : (
        <p className="text-sm text-muted-foreground">
          {submitter?.name ?? "出题人"} 正在选择{anime ? "番剧" : "歌曲"}
        </p>
      )}
    </div>
  );
}

export function SongGameArea(props: SongGameAreaProps) {
  return (
    <PhaseStage
      phaseKey={props.snapshot.phase}
      reserveBottom={props.snapshot.testMode}
      overlays={
        props.snapshot.testMode ? (
          <SongTestController
            run={props.run}
            snapshot={props.snapshot}
            isPending={props.isPending}
          />
        ) : null
      }
    >
      <GameStage {...props} />
    </PhaseStage>
  );
}
