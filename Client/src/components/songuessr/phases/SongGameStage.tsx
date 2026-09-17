import { useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  Clock3,
  Eye,
  Film,
  Flag,
  Headphones,
  Music2,
  Play,
  RotateCcw,
  UserCheck,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { SongWaitingPhase } from "@/components/songuessr/phases/SongWaitingPhase";
import { SongRoundResultPhase } from "@/components/songuessr/phases/SongRoundResultPhase";
import { SongTestController } from "@/components/songuessr/layout/SongTestController";
import { BangumiSearchDialog } from "@/components/songuessr/BangumiSearchDialog";
import { SongSearchDialog } from "@/components/songuessr/SongSearchDialog";
import {
  listContainer,
  listItem,
  phaseSwap,
  selectable,
  spinner,
} from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { BANGUMI_TRACK_KIND_LABELS } from "@/types";
import type {
  BangumiSubjectSearchResult,
  SongGuessAttempt,
  SongGuessDirection,
  SonGuessrPlayerView,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
} from "@/types";

const directionSymbol: Record<SongGuessDirection, string> = {
  higher: "↑",
  lower: "↓",
  equal: "=",
  unknown: "?",
};

export function SongAutoFilterSummary({ snapshot }: { snapshot: SonGuessrRoomSnapshot }) {
  const filters = snapshot.settings.autoFilters;
  const popularityLabel = filters.minPopularity === 0
    ? "不限热度"
    : `热度 ≥ ${filters.minPopularity >= 100_000 ? "100000" : filters.minPopularity}`;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
      <span className="font-medium text-primary">自动出题筛选</span>
      {filters.playlist ? <Badge variant="outline">歌单：{filters.playlist.name ?? filters.playlist.id}</Badge> : <Badge variant="outline">默认热歌榜</Badge>}
      {filters.artists.map((artist) => <Badge key={artist.id} variant="outline">歌手：{artist.name}</Badge>)}
      <Badge variant="outline">{popularityLabel}</Badge>
    </div>
  );
}

export function AnimeAutoFilterSummary({ snapshot }: { snapshot: SonGuessrRoomSnapshot }) {
  const filters = snapshot.settings.animeAutoFilters ?? {};
  const hasCustomKinds = filters.trackKinds && filters.trackKinds.length > 0 && filters.trackKinds.length < 18;
  const kindLabel = hasCustomKinds
    ? filters.trackKinds!.map((kind) => BANGUMI_TRACK_KIND_LABELS[kind] ?? kind).join("、")
    : undefined;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
      <span className="font-medium text-primary">自动出题筛选</span>
      <Badge variant="outline">番剧作品</Badge>
      {(filters.startYear || filters.endYear) ? <Badge variant="outline">{filters.startYear ?? "不限"}-{filters.endYear ?? "不限"}</Badge> : null}
      <Badge variant="outline">{filters.ranking === "year" ? "年榜" : "总榜"}前{filters.subjectLimit ?? 50}部</Badge>
      {kindLabel ? <Badge variant="outline">歌曲 {kindLabel}</Badge> : null}
      <Badge variant="outline">网易云热度 ≥ {(filters.songMinPopularity ?? 0) === 0 ? "不限" : filters.songMinPopularity}</Badge>
    </div>
  );
}

export function SectionHeader({ title, icon }: { title: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2.5 px-1">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {icon ?? <UserCheck className="h-3.5 w-3.5" />}
        {title}
      </div>
    </div>
  );
}

export function CandidateGrid({
  candidates,
  tone,
  onPick,
}: {
  candidates: Array<{ id: string; name: string }>;
  tone: "recommended" | "default";
  onPick: (playerId: string) => void;
}) {
  if (candidates.length === 0) {
    return <div className="px-1 py-3 text-xs text-muted-foreground">暂无玩家</div>;
  }

  return (
    <motion.div
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      variants={listContainer(candidates.length)}
      initial="initial"
      animate="animate"
    >
      {candidates.map((candidate) => (
        <motion.button
          key={candidate.id}
          type="button"
          variants={listItem}
          {...selectable}
          onClick={() => onPick(candidate.id)}
          className={cn(
            "cursor-pointer rounded-md border px-3 py-2.5 text-left text-sm transition-[background,border-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tone === "recommended"
              ? "border-primary/30 bg-primary/5 hover:border-primary/50 hover:bg-primary/10"
              : "hover:border-primary/40 hover:bg-primary/5",
          )}
        >
          <div className="flex items-center gap-1.5">
            {tone === "recommended" ? (
              <Eye className="h-3.5 w-3.5 shrink-0 text-primary" />
            ) : (
              <UserCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="break-words font-medium">{candidate.name}</span>
          </div>
        </motion.button>
      ))}
    </motion.div>
  );
}

export function AttemptList({
  attempts,
  title,
  showPlayerName = false,
}: {
  attempts: SongGuessAttempt[];
  title: string;
  showPlayerName?: boolean;
}) {
  if (attempts.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-md bg-muted">
      <div className="border-b border-background px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      </div>
      <div>
        {attempts.map((attempt) => (
          <div
            key={attempt.id}
            className="flex flex-col gap-2 border-b border-background px-4 py-3 last:border-b-0 sm:flex-row sm:items-center"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {attempt.result === "correct" ? (
                <Check className="h-4 w-4 text-emerald-600" />
              ) : attempt.result === "timeout" ? (
                <Clock3 className="h-4 w-4 text-amber-600" />
              ) : attempt.result === "gaveUp" ? (
                <Flag className="h-4 w-4 text-muted-foreground" />
              ) : (
                <X className="h-4 w-4 text-red-500" />
              )}
              <span className="min-w-0 break-words text-sm">
                {showPlayerName ? `${attempt.playerName}：` : ""}
                {attempt.guessedAnime
                  ? (attempt.guessedAnime.nameCn || attempt.guessedAnime.name)
                  : attempt.guessedSong
                  ? `${attempt.guessedSong.title} · ${attempt.guessedSong.artist}`
                  : attempt.result === "gaveUp"
                    ? "投降"
                    : "超时"}
              </span>
            </div>
            {attempt.feedback ? (
              <div className="flex flex-wrap gap-1 text-[11px]">
                <Badge variant="outline">
                  年份 {attempt.feedback.releaseYear ?? "?"} {directionSymbol[attempt.feedback.releaseYearDirection]}
                </Badge>
                <Badge variant="outline">
                  热度 {attempt.feedback.popularity ?? "?"} {directionSymbol[attempt.feedback.popularityDirection]}
                </Badge>
                {attempt.feedback.languageMatch !== undefined ? (
                  <Badge variant="outline">语种 {attempt.feedback.languageMatch ? "✓" : "×"}</Badge>
                ) : null}
                {attempt.feedback.sharedTags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

export interface SongGameAreaProps {
  snapshot: SonGuessrRoomSnapshot;
  privateState: SonGuessrPrivateState;
  me?: SonGuessrPlayerView;
  isHost: boolean;
  secondsLeft: number;
  volume: number;
  onVolumeChange: (value: number) => void;
  audioStatus: "loading" | "ready" | "error";
  audioPlaybackState: "idle" | "playing" | "completed";
  onPlayAudio: () => void;
  onRetryAudio: () => void;
  openSearch: (mode: "submit" | "guess") => void;
  searchMode: "submit" | "guess" | null;
  closeSearch: () => void;
  onSelectSearchSong: (songId: string, mode: "submit" | "guess") => Promise<void>;
  run: (type: string, payload?: Record<string, unknown>, success?: string) => Promise<void>;
  isPending?: (type: string) => boolean;
}

export function GameStage(props: SongGameAreaProps) {
  const {
    snapshot,
    privateState,
    me,
    isHost,
    secondsLeft,
    audioStatus,
    audioPlaybackState,
    onPlayAudio,
    onRetryAudio,
    openSearch,
    run,
    isPending,
  } = props;

  if (snapshot.phase === "waiting") {
    return <SongWaitingPhase snapshot={snapshot} me={me} isHost={isHost} run={run} isPending={isPending} />;
  }

  if (snapshot.phase === "choosingSubmitter") {
    const activeCandidates = snapshot.players.filter(
      (player) => player.membership === "active" && player.online && !player.isBot,
    );
    const spectatorCandidates = snapshot.players.filter(
      (player) => player.membership === "spectator" && player.online && !player.isBot,
    );
    return (
      <div className="flex flex-col items-center gap-6">
        <PhaseHeader icon={UserCheck} title="指定出题人" />
        {isHost ? (
          <div className="w-full max-w-xl space-y-5">
            {spectatorCandidates.length > 0 ? (
              <section>
                <SectionHeader title="旁观玩家" icon={<Eye className="h-3.5 w-3.5" />} />
                <CandidateGrid
                  candidates={spectatorCandidates}
                  tone="recommended"
                  onPick={(playerId) => run("song.game.chooseSubmitter", { playerId })}
                />
              </section>
            ) : null}
            <section>
              <SectionHeader title="玩家" icon={<UserCheck className="h-3.5 w-3.5" />} />
              <CandidateGrid
                candidates={activeCandidates}
                tone="default"
                onPick={(playerId) => run("song.game.chooseSubmitter", { playerId })}
              />
            </section>
          </div>
        ) : null}
      </div>
    );
  }

  if (snapshot.phase === "submittingSong") {
    const submitter = snapshot.players.find(
      (player) => player.id === snapshot.pendingSubmitterPlayerId,
    );
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-6 text-center">
        <PhaseHeader
          icon={snapshot.settings.questionType === "anime" ? Film : Music2}
          title={privateState.canSubmitSong ? "轮到你出题" : snapshot.settings.questionType === "anime" ? "等待出题人选番" : "等待出题人选歌"}
        />
        {privateState.canSubmitSong ? (
          <>
            <p className="text-sm text-muted-foreground">
              {snapshot.settings.questionType === "anime" ? "搜索一部有主题曲的番剧。" : "搜索一首可播放的网易云音乐歌曲。"}
            </p>
            <Button size="lg" className="min-w-[120px] gap-2" onClick={() => openSearch("submit")}>
            {snapshot.settings.questionType === "anime" ? <Film className="h-4 w-4" /> : <Music2 className="h-4 w-4" />}选择{snapshot.settings.questionType === "anime" ? "番剧" : "歌曲"}
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {submitter?.name ?? "出题人"} 正在选择{snapshot.settings.questionType === "anime" ? "番剧" : "歌曲"}
          </p>
        )}
      </div>
    );
  }

  if (snapshot.phase === "playing" && snapshot.currentRound) {
    const canObserveAllAttempts = privateState.isSubmitter || me?.membership === "spectator";
    const hasGivenUp = privateState.visibleAttempts.some(
      (attempt) => attempt.playerId === privateState.playerId && attempt.result === "gaveUp",
    );
    const hasLyrics = (snapshot.currentRound.lyricClip?.lines?.length ?? 0) > 0;
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <PhaseHeader icon={Headphones} title={snapshot.settings.questionType === "anime" ? "听歌猜番" : "听歌猜曲"} />
        <section className="space-y-5 rounded-md bg-muted p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {snapshot.settings.showLyrics && hasLyrics ? "歌词片段" : "音乐片段"}
            </h3>
            <div className="flex items-center gap-2">
              {snapshot.settings.showGuessTimer && privateState.canGuess && privateState.guessDeadlineAt ? (
                <Badge variant={secondsLeft <= 10 ? "destructive" : "outline"} className="gap-1 font-mono">
                  <Clock3 className="h-3.5 w-3.5" />{secondsLeft}s
                </Badge>
              ) : null}
              {audioStatus === "loading" ? (
                <Button variant="ghost" size="icon" className="h-8 w-8" disabled aria-label="音频加载中">
                  <motion.span
                    className="h-3.5 w-3.5 rounded-full border-2 border-primary border-t-transparent"
                    {...spinner}
                  />
                </Button>
              ) : audioStatus === "error" ? (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onRetryAudio} aria-label="重新加载音频">
                  <RotateCcw className="h-4 w-4" />
                </Button>
              ) : audioPlaybackState === "playing" ? (
                <Button variant="ghost" size="icon" className="h-8 w-8" disabled aria-label="音频播放中">
                  <motion.span
                    className="h-3.5 w-3.5 rounded-full border-2 border-primary border-t-transparent"
                    {...spinner}
                  />
                </Button>
              ) : audioPlaybackState === "completed" ? (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onPlayAudio} aria-label="重播音频">
                  <RotateCcw className="h-4 w-4" />
                </Button>
              ) : (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onPlayAudio} aria-label="播放音频">
                  <Play className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
          {snapshot.settings.questionMode === "automatic" ? (
            snapshot.settings.questionType === "anime"
              ? <AnimeAutoFilterSummary snapshot={snapshot} />
              : <SongAutoFilterSummary snapshot={snapshot} />
          ) : null}
          {snapshot.settings.showLyrics ? (
            <div
              className="select-none space-y-2 rounded-md bg-background/60 p-5 text-center"
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
            >
              {hasLyrics ? (
                snapshot.currentRound.lyricClip.lines.map((line) => (
                  <p key={`${line.time}-${line.text}`} className="leading-relaxed">{line.text}</p>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">当前歌曲为纯音乐或无歌词</p>
              )}
            </div>
          ) : (
            <div className="rounded-md bg-background/60 p-5 text-center text-sm text-muted-foreground">
              本房间已关闭歌词提示，请根据音乐进行猜测
            </div>
          )}
          {snapshot.settings.questionType === "anime" && privateState.submittedAnime ? (
            <div className="break-words rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm">本轮答案：<strong>{privateState.submittedAnime.nameCn || privateState.submittedAnime.name}</strong></div>
          ) : privateState.submittedSong ? (
            <div className="break-words rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
              本轮答案：<strong>{privateState.submittedSong.title}</strong> · {privateState.submittedSong.artist}
            </div>
          ) : null}
          {me?.membership === "spectator" ? (
            <p className="text-center text-sm text-muted-foreground">你正在旁观本轮游戏</p>
          ) : privateState.canGuess || privateState.canGiveUp ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              {privateState.canGuess ? (
                <Button className="flex-1 gap-2" onClick={() => openSearch("guess")}>
                  <Play className="h-4 w-4" />提交{snapshot.settings.questionType === "anime" ? "番剧猜测" : "猜测"}（剩余 {privateState.remainingGuesses} 次）
                </Button>
              ) : null}
              {privateState.canGiveUp ? (
                <Button
                  variant="outline"
                  className="gap-2"
                  disabled={isPending?.("song.game.giveUp")}
                  loading={isPending?.("song.game.giveUp")}
                  onClick={() => void run("song.game.giveUp")}
                >
                  {isPending?.("song.game.giveUp") ? (
                    "正在放弃..."
                  ) : (
                    <>
                      <Flag className="h-4 w-4" />投降
                    </>
                  )}
                </Button>
              ) : null}
            </div>
          ) : hasGivenUp ? (
            <p className="text-center text-sm text-muted-foreground">
              {snapshot.solo ? "你已放弃本回合" : "你已放弃本回合，等待其他玩家"}
            </p>
          ) : !privateState.isSubmitter ? (
            <p className="text-center text-sm text-muted-foreground">本轮操作已完成</p>
          ) : null}
        </section>
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

export function SongGameArea(props: SongGameAreaProps) {
  const phaseRef = useRef<HTMLDivElement>(null);

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden", props.snapshot.testMode && "pb-16")}>
      <ScrollArea data-testid="game-area-scroll" className="min-h-0 flex-1">
        <div className="p-6 md:p-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={props.snapshot.phase}
              variants={phaseSwap}
              initial="initial"
              animate="animate"
              exit="exit"
              onAnimationComplete={(definition) => {
                if (definition !== "animate") return;
                const node = phaseRef.current;
                if (node) node.style.transform = "";
              }}
              ref={phaseRef}
              style={{ willChange: "transform, opacity" }}
            >
              <GameStage {...props} />
            </motion.div>
          </AnimatePresence>
          {props.searchMode && props.snapshot.settings.questionType === "anime" ? (
            <BangumiSearchDialog
              open
              onOpenChange={(open) => { if (!open) props.closeSearch(); }}
              title={props.searchMode === "submit" ? "选择本回合番剧" : "提交你的番剧猜测"}
              description="番剧信息只会在回合结束后公开。"
              actionLabel={props.searchMode === "submit" ? "设为答案" : "猜这部"}
              onSelect={(subject: BangumiSubjectSearchResult) => props.onSelectSearchSong(subject.id, props.searchMode!)}
            />
          ) : props.searchMode ? (
            <SongSearchDialog
              open
              onOpenChange={(open) => { if (!open) props.closeSearch(); }}
              title={props.searchMode === "submit" ? "选择本回合答案" : "提交你的猜测"}
              description={props.searchMode === "submit" ? "歌曲信息只会在回合结束后公开。" : "每次错误猜测会提供年代、热度、语种与标签反馈。"}
              actionLabel={props.searchMode === "submit" ? "设为答案" : "猜这首"}
              onSelect={(song) => props.onSelectSearchSong(song.id, props.searchMode!)}
            />
          ) : null}
        </div>
      </ScrollArea>
      {props.snapshot.testMode ? (
        <SongTestController run={props.run} snapshot={props.snapshot} isPending={props.isPending} />
      ) : null}
    </div>
  );
}
