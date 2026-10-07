import React from "react";
import { motion, type Variants } from "framer-motion";
import { Check, Film, Music2, Trophy, X } from "lucide-react";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { ScoreTable, type ScoreTableColumn } from "@/components/common/room/ScoreTable";
import { followDelay, listItem, revealCard, springSettleMs } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import {
  BANGUMI_TRACK_KIND_LABELS,
  detectExplicitTrackKind,
  type BangumiMusicTrack,
  type BangumiMusicTrackKind,
  type SonGuessrPlayerView,
  type SonGuessrPrivateState,
  type SonGuessrRoomSnapshot,
  type SonGuessrRoundSummary,
} from "@/types";

function formatTrackKind(
  kind?: BangumiMusicTrackKind,
  track?: BangumiMusicTrack,
  song?: SonGuessrRoundSummary["song"],
): string {
  const candidateText = `${track?.title ?? ""} ${song?.title ?? ""} ${song?.album ?? ""} ${song?.encyclopedia?.tags?.join(" ") ?? ""}`;
  let effectiveKind: BangumiMusicTrackKind | undefined = detectExplicitTrackKind(candidateText) ?? track?.kind ?? kind;
  if (!effectiveKind || effectiveKind === "theme") {
    if (/原声|soundtrack|\bost\b/i.test(candidateText)) effectiveKind = "ost";
    else if (/角色[歌曲]|character(?:\s*song)?/i.test(candidateText)) effectiveKind = "character";
    else if (/\bremix\b|重混/i.test(candidateText)) effectiveKind = "remix";
    else if (/同人/i.test(candidateText)) effectiveKind = "doujin";
    else if (/印象[曲歌]|image(?:\s*song)?/i.test(candidateText)) effectiveKind = "image";
    else if (/vocaloid/i.test(candidateText)) effectiveKind = "vocaloid";
    else if (/\bdrama\b|广播剧|廣播劇/i.test(candidateText)) effectiveKind = "drama";
    else if (/\bvocal\b/i.test(candidateText)) effectiveKind = "vocal";
    else if (/\bradio\b|广播|廣播/i.test(candidateText)) effectiveKind = "radio";
    else if (/\barrange\b|改编|改編|编曲|編曲/i.test(candidateText)) effectiveKind = "arrange";
    else if (/单曲|單曲|\bsingle\b/i.test(candidateText)) effectiveKind = "single";
    else if (/精选|精選|\bbest\b|collection/i.test(candidateText)) effectiveKind = "collection";
    else if (/朗读|朗讀/i.test(candidateText)) effectiveKind = "reading";
    else if (/艺人|藝人|album/i.test(candidateText)) effectiveKind = "artistAlbum";
    else effectiveKind = "theme";
  }
  return BANGUMI_TRACK_KIND_LABELS[effectiveKind] ?? "主题曲";
}

/**
 * 歌曲信息。`answer` 是答案卡本身（标题 `text-xl`）；`related` 是番剧答案下的关联歌曲，标题降一档。
 */
export function SongSettlementDetails({
  song,
  trackKindBadge,
  variant = "answer",
}: {
  song: SonGuessrRoundSummary["song"];
  trackKindBadge?: React.ReactNode;
  variant?: "answer" | "related";
}) {
  const related = variant === "related";
  const Title = related ? "h4" : "h3";
  return (
    <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
      {song.pictureUrl ? (
        <img src={song.pictureUrl} alt="" className="h-28 w-28 rounded-md object-cover shadow-sm" />
      ) : (
        <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-md bg-background">
          <Music2 className="h-9 w-9 text-muted-foreground" aria-hidden="true" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
          <Title className={cn("break-words font-semibold", related ? "text-lg" : "text-xl")}>{song.title}</Title>
          {trackKindBadge}
        </div>
        <p className="mt-1 text-muted-foreground">
          {song.artist}{song.album ? ` · ${song.album}` : ""}
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-2 text-xs sm:justify-start">
          {song.releaseYear ? <Badge variant="outline">{song.releaseYear}</Badge> : null}
          {song.language ? <Badge variant="outline">{song.language}</Badge> : null}
          {song.encyclopedia?.tags?.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
        </div>

        {song.encyclopedia?.aliases?.length ? (
          <p className="mt-3 text-xs text-muted-foreground">
            别名：{song.encyclopedia.aliases.join("、")}
          </p>
        ) : null}
        {song.encyclopedia?.summary ? (
          <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
            {song.encyclopedia.summary}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** 累计得分在答案卡落定之后再滚，读作这一轮的分数落进了总分。 */
const SOLO_ROLL_DELAY = springSettleMs(revealCard.transition) / 1000;

export function SoloRoundOutcome({
  correct,
  me,
  delta,
  rounds,
}: {
  correct: boolean;
  me?: SonGuessrPlayerView;
  /** 本轮得分，累计得分从 `score - delta` 滚起 */
  delta: number;
  rounds: number;
}) {
  const score = me?.score ?? 0;
  const Icon = correct ? Check : X;
  return (
    <section className="rounded-md bg-muted p-4 text-center">
      <p className={cn("flex items-center justify-center gap-1.5 text-base font-semibold", correct ? "text-success" : "text-destructive")}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        {correct ? "本轮答对" : "本轮未答对"}
      </p>
      <div className="mt-2 flex items-center justify-center gap-4 text-sm text-muted-foreground">
        <span>累计得分 <AnimatedNumber value={score} from={score - delta} delay={SOLO_ROLL_DELAY} gain="above" /></span>
        <span data-testid="solo-correct-rounds">答对 {me?.correctGuesses ?? 0}/{rounds} 轮</span>
      </div>
    </section>
  );
}

const SONG_SCORE_COLUMNS: ScoreTableColumn[] = [
  { key: "delta", header: "本轮", signed: true },
  { key: "score", header: "总分", tone: "strong" },
  { key: "hits", header: "命中", tone: "muted" },
];

/** 多人模式的得分统计：服务端已按总分从高到低排好，已有得分的首行加奖杯 */
export function SongScoreTable({
  scores,
  contributors,
}: {
  scores: SonGuessrRoundSummary["scores"];
  /** 本轮答对的玩家：行落定后浮起浅底，与奖杯各说一件事 */
  contributors: string[];
}) {
  const correctIds = new Set(contributors);
  return (
    <ScoreTable
      title="得分统计"
      columns={SONG_SCORE_COLUMNS}
      ranked
      rows={scores.map((score, index) => ({
        key: score.playerId,
        name: index === 0 && score.score > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Trophy className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span className="sr-only">第一名：</span>
            {score.playerName}
          </span>
        ) : score.playerName,
        cells: { delta: score.delta, score: score.score, hits: `${score.correctGuesses}/${score.totalGuesses}` },
        rollFrom: { score: score.score - score.delta },
        contributor: correctIds.has(score.playerId),
      }))}
    />
  );
}

/** 番剧答案卡里的关联歌曲段：晚卡片一拍再推入。 */
const RELATED_SONG_REVEAL: Variants = {
  initial: {},
  animate: { transition: { delayChildren: followDelay } },
};

export interface SongRoundResultPhaseProps {
  snapshot: SonGuessrRoomSnapshot;
  privateState: SonGuessrPrivateState;
  me?: SonGuessrPlayerView;
  isHost: boolean;
  run: (type: string, payload?: Record<string, unknown>, success?: string) => Promise<void>;
  isPending?: (type: string) => boolean;
}

export function SongRoundResultPhase({
  snapshot,
  privateState,
  me,
  isHost,
  run,
  isPending,
}: SongRoundResultPhaseProps) {
  const summary = snapshot.roundSummary;
  if (!summary) return null;

  const isNextRound = Boolean(isPending?.("song.game.nextRound"));
  const isFinishing = Boolean(isPending?.("song.game.finish"));

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PhaseHeader icon={snapshot.settings.questionType === "anime" ? Film : Music2} title="答案揭晓" />
      {/* 答案卡：整卡回弹落定；下方得分表在卡之外，两者各落各的 */}
      <motion.section
        initial={revealCard.initial}
        animate={revealCard.animate}
        transition={revealCard.transition}
        className="space-y-4 rounded-md bg-muted p-4"
      >
        {snapshot.settings.questionType === "anime" && summary.anime ? (
          <>
            <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
              {summary.anime.imageUrl ? (
                <img src={summary.anime.imageUrl} alt="" className="h-28 w-20 rounded-md object-cover shadow-sm" />
              ) : (
                <div className="flex h-28 w-20 shrink-0 items-center justify-center rounded-md bg-background">
                  <Film className="h-9 w-9 text-muted-foreground" aria-hidden="true" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-xl font-semibold">{summary.anime.nameCn || summary.anime.name}</h3>
                <p className="mt-1 text-muted-foreground">{summary.anime.name}</p>
                <div className="mt-3 flex flex-wrap justify-center gap-2 text-xs sm:justify-start">
                  {summary.anime.year ? <Badge variant="outline">{summary.anime.year}</Badge> : null}
                  {summary.anime.rating ? <Badge variant="outline">评分 {summary.anime.rating.toFixed(1)}</Badge> : null}
                  {summary.anime.tags.slice(0, 5).map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
                </div>
              </div>
            </div>

            {/* 关联歌曲是答案的从属信息：分隔线随卡片就位，内容晚一拍推入 */}
            <motion.div variants={RELATED_SONG_REVEAL} initial="initial" animate="animate" className="border-t border-background pt-4">
              <motion.div variants={listItem} className="origin-left">
                <div className="mb-3 flex items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground sm:justify-start">
                  <Music2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>关联歌曲</span>
                </div>
                <SongSettlementDetails
                  variant="related"
                  song={summary.song}
                  trackKindBadge={
                    <Badge variant="default">
                      {formatTrackKind(summary.animeTrack?.kind, summary.animeTrack, summary.song)}
                    </Badge>
                  }
                />
              </motion.div>
            </motion.div>
          </>
        ) : (
          <SongSettlementDetails song={summary.song} />
        )}
      </motion.section>
      {snapshot.solo ? (
        <SoloRoundOutcome
          correct={summary.correctPlayerIds.includes(privateState.playerId)}
          me={me}
          delta={summary.scores.find((score) => score.playerId === privateState.playerId)?.delta ?? 0}
          rounds={summary.roundNumber}
        />
      ) : (
        <SongScoreTable scores={summary.scores} contributors={summary.correctPlayerIds} />
      )}
      {isHost ? (
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="outline"
            size="lg"
            disabled={isFinishing || isNextRound}
            loading={isFinishing}
            onClick={() => void run("song.game.finish")}
          >
            {snapshot.solo ? "结束本局" : "返回等待阶段"}
          </Button>
          <Button
            size="lg"
            disabled={
              (snapshot.settings.questionMode === "automatic" && !snapshot.musicAccountReady) ||
              isNextRound ||
              isFinishing
            }
            loading={isNextRound}
            onClick={() => void run("song.game.nextRound")}
          >
            再来一轮
          </Button>
        </div>
      ) : (
        // 自动出题同样由房主点「再来一轮」才开始，措辞不分出题方式
        <p className="text-center text-sm text-muted-foreground">等待房主开始下一轮</p>
      )}
    </div>
  );
}
