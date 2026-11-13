import { lazy, Suspense, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Film, Music2 } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { PhaseHeader } from "@/components/common/PhaseHeader";
import { AnimeSearch, SongSearch } from "@/components/songuessr/SongSearch";
import { phaseSwap } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import type { SongClipPreview, SongSearchResult } from "@bakagame/shared";
import type { SongGameAreaProps } from "./SongGameAreaProps";

const SongClipEditor = lazy(async () => ({
  default: (await import("@/components/songuessr/SongClipEditor")).SongClipEditor,
}));

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
export function SongSubmittingPhase({
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
