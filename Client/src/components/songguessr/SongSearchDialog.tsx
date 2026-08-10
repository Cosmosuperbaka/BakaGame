import { useEffect, useState } from "react";
import { LoaderCircle, Music2, Search } from "lucide-react";
import type { SongSearchResult } from "@/types";
import { useSongGuessrStore } from "@/stores/useSongGuessrStore";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

interface SongSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  actionLabel: string;
  onSelect: (song: SongSearchResult) => Promise<void>;
}

export function SongSearchDialog({
  open,
  onOpenChange,
  title,
  description,
  actionLabel,
  onSelect,
}: SongSearchDialogProps) {
  const searchMusic = useSongGuessrStore((state) => state.searchMusic);
  const setNotice = useSongGuessrStore((state) => state.setNotice);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SongSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  useEffect(() => {
    const keyword = query.trim();
    if (!open || !keyword) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const nextResults = await searchMusic(keyword);
        if (!cancelled) setResults(nextResults);
      } catch (error) {
        if (!cancelled) {
          setNotice((error as { message?: string }).message ?? "搜索歌曲失败", "error");
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, searchMusic, setNotice]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setQuery("");
      setResults([]);
      setSearching(false);
      setSubmittingId(null);
    }
    onOpenChange(nextOpen);
  };

  const choose = async (song: SongSearchResult) => {
    setSubmittingId(song.id);
    try {
      await onSelect(song);
      handleOpenChange(false);
    } catch (error) {
      setNotice((error as { message?: string }).message ?? "提交歌曲失败", "error");
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              if (!nextQuery.trim()) {
                setResults([]);
                setSearching(false);
              }
            }}
            placeholder="输入歌名、歌手或专辑"
            className="pl-9"
          />
        </div>

        <ScrollArea className="h-[min(55vh,28rem)] rounded-lg border bg-muted/25">
          <div className="space-y-2 p-3">
            {searching ? (
              <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                正在查询网易云音乐
              </div>
            ) : results.length > 0 ? (
              results.map((song) => (
                <div
                  key={song.id}
                  className="flex items-center gap-3 rounded-lg bg-card p-3 shadow-sm"
                >
                  {song.pictureUrl ? (
                    <img
                      src={song.pictureUrl}
                      alt=""
                      className="h-12 w-12 rounded-md object-cover"
                    />
                  ) : (
                    <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted">
                      <Music2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1 break-words">
                    <div className="font-medium">{song.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {song.artist}{song.album ? ` · ${song.album}` : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    disabled={Boolean(submittingId)}
                    onClick={() => void choose(song)}
                  >
                    {submittingId === song.id ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                      actionLabel
                    )}
                  </Button>
                </div>
              ))
            ) : query.trim() ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                没有找到匹配歌曲
              </div>
            ) : (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                搜索结果会显示在这里
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
