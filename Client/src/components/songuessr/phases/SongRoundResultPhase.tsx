import React from "react";
import { Film, Music2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { PhaseHeader } from "@/components/common/PhaseHeader";
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

export function SongSettlementDetails({
  song,
  trackKindBadge,
}: {
  song: SonGuessrRoundSummary["song"];
  trackKindBadge?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
      {song.pictureUrl ? (
        <img src={song.pictureUrl} alt="" className="h-28 w-28 rounded-md object-cover shadow-md" />
      ) : (
        <div className="flex h-28 w-28 items-center justify-center rounded-md bg-background/60">
          <Music2 className="h-9 w-9" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
          <h2 className="break-words text-2xl font-bold">{song.title}</h2>
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

export function SoloRoundOutcome({
  correct,
  me,
  rounds,
}: {
  correct: boolean;
  me?: SonGuessrPlayerView;
  rounds: number;
}) {
  return (
    <section className="rounded-md bg-muted p-4 text-center">
      <p className="text-base font-semibold">{correct ? "本轮答对" : "本轮未答对"}</p>
      <div className="mt-2 flex items-center justify-center gap-4 text-sm text-muted-foreground">
        <span>累计得分 {me?.score ?? 0}</span>
        <span data-testid="solo-correct-rounds">答对 {me?.correctGuesses ?? 0}/{rounds} 轮</span>
      </div>
    </section>
  );
}

export function ScoreTable({
  scores,
}: {
  scores: Array<{
    playerId: string;
    playerName: string;
    score: number;
    delta: number;
    correctGuesses: number;
    totalGuesses: number;
  }>;
}) {
  return (
    <section className="overflow-hidden rounded-md bg-muted">
      <div className="border-b border-background px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">得分统计</h3>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-background text-xs text-muted-foreground">
            <th className="px-4 py-2 text-left font-medium">玩家</th>
            <th className="px-4 py-2 text-right font-medium">本轮</th>
            <th className="px-4 py-2 text-right font-medium">总分</th>
            <th className="px-4 py-2 text-right font-medium">命中</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((score, index) => (
            <tr key={score.playerId} className="border-b border-background last:border-b-0">
              <td className="px-4 py-2.5 font-medium">{index === 0 ? "🏆 " : ""}{score.playerName}</td>
              <td className="px-4 py-2.5 text-right">{score.delta >= 0 ? "+" : ""}{score.delta}</td>
              <td className="px-4 py-2.5 text-right font-semibold">{score.score}</td>
              <td className="px-4 py-2.5 text-right text-muted-foreground">
                {score.correctGuesses}/{score.totalGuesses}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

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
      {snapshot.settings.questionType === "anime" && summary.anime ? (
        <section className="space-y-4 rounded-md bg-muted p-4">
          <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
            {summary.anime.imageUrl ? (
              <img src={summary.anime.imageUrl} alt="" className="h-28 w-20 rounded-md object-cover shadow-md" />
            ) : (
              <div className="flex h-28 w-20 items-center justify-center rounded-md bg-background/60">
                <Film className="h-9 w-9" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h2 className="break-words text-2xl font-bold">{summary.anime.nameCn || summary.anime.name}</h2>
              <p className="mt-1 text-muted-foreground">{summary.anime.name}</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2 text-xs sm:justify-start">
                {summary.anime.year ? <Badge variant="outline">{summary.anime.year}</Badge> : null}
                {summary.anime.rating ? <Badge variant="outline">评分 {summary.anime.rating.toFixed(1)}</Badge> : null}
                {summary.anime.tags.slice(0, 5).map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
              </div>
            </div>
          </div>

          <div className="border-t border-border/60 pt-4">
            <div className="mb-3 flex items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground sm:justify-start">
              <Music2 className="h-3.5 w-3.5" />
              <span>关联歌曲</span>
            </div>
            <SongSettlementDetails
              song={summary.song}
              trackKindBadge={
                <Badge variant="default">
                  {formatTrackKind(summary.animeTrack?.kind, summary.animeTrack, summary.song)}
                </Badge>
              }
            />
          </div>
        </section>
      ) : (
        <section className="rounded-md bg-muted p-4">
          <SongSettlementDetails song={summary.song} />
        </section>
      )}
      {snapshot.solo ? (
        <SoloRoundOutcome
          correct={summary.correctPlayerIds.includes(privateState.playerId)}
          me={me}
          rounds={snapshot.roundNumber}
        />
      ) : (
        <ScoreTable scores={summary.scores} />
      )}
      {isHost ? (
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={isFinishing || isNextRound}
            loading={isFinishing}
            onClick={() => void run("song.game.finish")}
          >
            {isFinishing ? "正在返回..." : snapshot.solo ? "结束本局" : "返回等待阶段"}
          </Button>
          <Button
            disabled={
              (snapshot.settings.questionMode === "automatic" && !snapshot.musicAccountReady) ||
              isNextRound ||
              isFinishing
            }
            loading={isNextRound}
            onClick={() => void run("song.game.nextRound")}
          >
            {isNextRound ? "正在准备下一轮..." : "再来一轮"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
