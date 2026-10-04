import { useEffect, useState } from "react";
import { ArrowLeft, Film, Music2, Search } from "lucide-react";
import type { BangumiSongCandidate, BangumiSubjectSearchResult } from "@/types";
import { BANGUMI_TRACK_KIND_LABELS } from "@/types";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { CloseButton } from "@/components/ui/CloseButton";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { Spinner } from "@/components/ui/Spinner";

interface BangumiSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  actionLabel: string;
  mode?: "submit" | "guess";
  onSelect: (subject: BangumiSubjectSearchResult, songId?: string) => Promise<void>;
}

export function BangumiSearchDialog(props: BangumiSearchDialogProps) {
  return props.open ? <BangumiSearchPanel {...props} /> : null;
}

function BangumiSearchPanel({
  onOpenChange,
  title,
  description,
  actionLabel,
  mode = "guess",
  onSelect,
}: BangumiSearchDialogProps) {
  const searchBangumi = useSonGuessrStore((state) => state.searchBangumi);
  const resolveAnimeSongs = useSonGuessrStore((state) => state.resolveAnimeSongs);
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BangumiSubjectSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  // 手动出题两步状态：已选择的番剧及该番剧匹配的歌曲列表
  const [selectedSubject, setSelectedSubject] = useState<BangumiSubjectSearchResult | null>(null);
  const [songs, setSongs] = useState<BangumiSongCandidate[]>([]);
  const [loadingSongs, setLoadingSongs] = useState(false);
  const [submittingSongId, setSubmittingSongId] = useState<string | null>(null);

  useEffect(() => {
    const keyword = query.trim();
    if (!keyword) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const next = await searchBangumi(keyword);
        if (!cancelled) setResults(next);
      } catch (error) {
        if (!cancelled) setNotice((error as { message?: string }).message ?? "搜索番剧失败", "error");
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, searchBangumi, setNotice]);

  const close = () => {
    setSearching(false);
    setQuery("");
    setResults([]);
    setSelectedSubject(null);
    setSongs([]);
    setSubmittingId(null);
    setSubmittingSongId(null);
    onOpenChange(false);
  };

  const handleChooseSubject = async (subject: BangumiSubjectSearchResult) => {
    if (mode !== "submit") {
      setSubmittingId(subject.id);
      try {
        await onSelect(subject);
        close();
      } catch (error) {
        setNotice((error as { message?: string }).message ?? "提交番剧失败", "error");
      } finally {
        setSubmittingId(null);
      }
      return;
    }

    // 出题模式：进入关联歌曲挑选阶段
    setSelectedSubject(subject);
    setLoadingSongs(true);
    try {
      const matched = await resolveAnimeSongs(subject.id);
      setSongs(matched);
    } catch (error) {
      setNotice((error as { message?: string }).message ?? "获取关联歌曲失败", "error");
      setSongs([]);
    } finally {
      setLoadingSongs(false);
    }
  };

  const handleChooseSong = async (subject: BangumiSubjectSearchResult, songId: string) => {
    setSubmittingSongId(songId);
    try {
      await onSelect(subject, songId);
      close();
    } catch (error) {
      setNotice((error as { message?: string }).message ?? "提交出题失败", "error");
    } finally {
      setSubmittingSongId(null);
    }
  };

  // 第二步：选择目标关联曲界面
  if (selectedSubject) {
    return (
      <section className="mt-4 space-y-3 rounded-md border bg-background p-4 shadow-sm" aria-label="选择关联曲">
        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setSelectedSubject(null);
              setSongs([]);
            }}
          >
            <ArrowLeft className="h-4 w-4" />
            更换番剧
          </Button>
          <CloseButton onClick={close} aria-label="关闭搜索" />
        </div>

        <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-2.5">
          {selectedSubject.imageUrl ? (
            <img src={selectedSubject.imageUrl} alt="" className="h-12 w-9 shrink-0 rounded-md object-cover" />
          ) : (
            <div className="flex h-12 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
              <Film className="h-4 w-4 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0 flex-1 break-words">
            <div className="text-sm font-medium">{selectedSubject.nameCn || selectedSubject.name}</div>
            <div className="text-xs text-muted-foreground">
              {selectedSubject.name}
              {selectedSubject.year ? ` · ${selectedSubject.year}` : ""}
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground">选择目标关联曲</h4>
        </div>

        <ScrollArea className="h-[min(45vh,24rem)] rounded-md border bg-muted/40">
          <div className="space-y-2 p-3">
            {loadingSongs ? (
              <div role="status" className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                正在匹配关联歌曲
              </div>
            ) : songs.length > 0 ? (
              songs.map((candidate) => {
                const kindLabel = BANGUMI_TRACK_KIND_LABELS[candidate.track.kind] ?? candidate.track.kind;
                const isSubmitting = submittingSongId === candidate.song.id;
                return (
                  <div key={candidate.song.id} className="flex items-center gap-3 rounded-md bg-card p-3 shadow-sm">
                    {candidate.song.pictureUrl ? (
                      <img src={candidate.song.pictureUrl} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" />
                    ) : (
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-muted">
                        <Music2 className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1 break-words">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="shrink-0 text-2xs font-normal">
                          {kindLabel}
                        </Badge>
                        <span className="font-medium text-sm truncate">{candidate.song.title}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground truncate">
                        {candidate.song.artist}
                        {candidate.song.album ? ` · ${candidate.song.album}` : ""}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      disabled={Boolean(submittingSongId)}
                      onClick={() => void handleChooseSong(selectedSubject, candidate.song.id)}
                    >
                      {isSubmitting ? <Spinner /> : actionLabel}
                    </Button>
                  </div>
                );
              })
            ) : (
              <div className="flex flex-col h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                <span>该番剧未匹配到可播放的关联歌曲</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSelectedSubject(null);
                    setSongs([]);
                  }}
                >
                  返回重新选择番剧
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>
      </section>
    );
  }

  // 第一步：搜索番剧界面
  return (
    <section className="mt-4 space-y-3 rounded-md border bg-background p-4 shadow-sm" aria-label={title}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 text-xs text-muted-foreground">{description}</p></div>
        <CloseButton onClick={close} aria-label="关闭搜索" />
      </div>
      <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input autoFocus value={query} onChange={(event) => { const value = event.target.value; setQuery(value); setSearching(false); setResults([]); }} placeholder="输入番剧名称" className="pl-9" /></div>
      <ScrollArea className="h-[min(45vh,24rem)] rounded-md border bg-muted/40"><div className="space-y-2 p-3">
        {searching ? <div role="status" className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner />正在查询 Bangumi</div> : results.length > 0 ? results.map((subject) => (
          <div key={subject.id} className="flex items-center gap-3 rounded-md bg-card p-3 shadow-sm">
            {subject.imageUrl ? <img src={subject.imageUrl} alt="" className="h-14 w-10 rounded-md object-cover" /> : <div className="flex h-14 w-10 items-center justify-center rounded-md bg-muted"><Film className="h-5 w-5 text-muted-foreground" /></div>}
            <div className="min-w-0 flex-1 break-words"><div className="font-medium">{subject.nameCn || subject.name}</div><div className="text-xs text-muted-foreground">{subject.name}{subject.year ? ` · ${subject.year}` : ""}{subject.rating ? ` · ${subject.rating.toFixed(1)} 分` : ""}</div></div>
            <Button size="sm" disabled={Boolean(submittingId)} onClick={() => void handleChooseSubject(subject)}>{submittingId === subject.id ? <Spinner /> : actionLabel}</Button>
          </div>
        )) : query.trim() ? <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">没有找到匹配番剧</div> : <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">搜索结果会显示在这里</div>}
      </div></ScrollArea>
    </section>
  );
}
