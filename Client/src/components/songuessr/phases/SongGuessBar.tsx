import type { Ref } from "react";
import { motion } from "framer-motion";
import { Flag } from "lucide-react";
import { useSecondsLeft } from "@/hooks/UseSecondsLeft";
import { Button } from "@/components/ui/Button";
import { CountdownBadge } from "@/components/common/room/CountdownBadge";
import { AnimeSearch, SongSearch } from "@/components/songuessr/SongSearch";
import { listItem } from "@/lib/Motion";
import type { SongGameAreaProps } from "./SongGameAreaProps";

export function SongGuessCountdown({ deadlineAt }: { deadlineAt?: number | null }) {
  const secondsLeft = useSecondsLeft(deadlineAt);
  return <CountdownBadge secondsLeft={secondsLeft} />;
}

/**
 * 猜测栏：搜索框与投降按钮独立成行，放在歌词卡之下，不和歌词挤在同一块里。
 * 上方一行是剩余次数与限时；音频还没就绪时搜索框禁用，投降仍可用。
 * md 以下歌词卡就占满首屏，猜测栏贴在游戏区滚动视口的底边（区内遮罩档 `bg-panel/90 backdrop-blur-sm`），
 * 左右以负外边距铺满游戏区内边距；滚到它的原位后随内容回到流内。
 */
export function SongGuessBar({
  ref,
  snapshot,
  privateState,
  guessDeadlineAt,
  onSelectSearchSong,
  run,
  isPending,
  guessedIds,
}: SongGameAreaProps & {
  guessedIds: string[];
  ref?: Ref<HTMLElement>;
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
        <span>
          {privateState.canGuess
            ? `剩余 ${privateState.remainingGuesses} 次猜测`
            : "音频准备中，请稍候…"}
        </span>
        {snapshot.settings.showGuessTimer &&
        privateState.canGuess &&
        privateState.guessDeadlineAt ? (
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
          <Button
            variant="outline"
            className="h-10 shrink-0"
            loading={givingUp}
            onClick={() => void run("song.game.giveUp")}
            data-agent-control="song.guess.giveup"
          >
            {givingUp ? null : <Flag />}投降
          </Button>
        ) : null}
      </div>
    </motion.section>
  );
}
