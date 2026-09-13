import { useEffect, useState } from "react";
import { Film, LoaderCircle, Search, X } from "lucide-react";
import type { BangumiSubjectSearchResult } from "@/types";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { ScrollArea } from "@/components/ui/ScrollArea";

interface BangumiSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  actionLabel: string;
  onSelect: (subject: BangumiSubjectSearchResult) => Promise<void>;
}

export function BangumiSearchDialog({ open, onOpenChange, title, description, actionLabel, onSelect }: BangumiSearchDialogProps) {
  const searchBangumi = useSonGuessrStore((state) => state.searchBangumi);
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BangumiSubjectSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  useEffect(() => {
    const keyword = query.trim();
    if (!open || !keyword) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const next = await searchBangumi(keyword);
        if (!cancelled) setResults(next);
      } catch (error) {
        if (!cancelled) setNotice((error as { message?: string }).message ?? "搜索 Bangumi 失败", "error");
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, query, searchBangumi, setNotice]);

  const close = () => {
    setQuery("");
    setResults([]);
    setSubmittingId(null);
    onOpenChange(false);
  };

  const choose = async (subject: BangumiSubjectSearchResult) => {
    setSubmittingId(subject.id);
    try {
      await onSelect(subject);
      close();
    } catch (error) {
      setNotice((error as { message?: string }).message ?? "提交 Bangumi 失败", "error");
    } finally {
      setSubmittingId(null);
    }
  };

  if (!open) return null;
  return (
    <section className="mt-4 space-y-3 rounded-md border bg-background/80 p-4 shadow-sm" aria-label={title}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 text-xs text-muted-foreground">{description}</p></div>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={close} aria-label="关闭搜索"><X className="h-4 w-4" /></Button>
      </div>
      <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input autoFocus value={query} onChange={(event) => { const value = event.target.value; setQuery(value); if (!value.trim()) setResults([]); }} placeholder="输入 Bangumi 条目名称" className="pl-9" /></div>
      <ScrollArea className="h-[min(45vh,24rem)] rounded-md border bg-muted/25"><div className="space-y-2 p-3">
        {searching ? <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />正在查询 Bangumi</div> : results.length > 0 ? results.map((subject) => (
          <div key={subject.id} className="flex items-center gap-3 rounded-md bg-card p-3 shadow-sm">
            {subject.imageUrl ? <img src={subject.imageUrl} alt="" className="h-14 w-10 rounded object-cover" /> : <div className="flex h-14 w-10 items-center justify-center rounded bg-muted"><Film className="h-5 w-5 text-muted-foreground" /></div>}
            <div className="min-w-0 flex-1 break-words"><div className="font-medium">{subject.nameCn || subject.name}</div><div className="text-xs text-muted-foreground">{subject.name}{subject.year ? ` · ${subject.year}` : ""}{subject.rating ? ` · ${subject.rating.toFixed(1)} 分` : ""}</div></div>
            <Button size="sm" disabled={Boolean(submittingId)} onClick={() => void choose(subject)}>{submittingId === subject.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : actionLabel}</Button>
          </div>
        )) : query.trim() ? <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">没有找到匹配的 Bangumi 条目</div> : <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">搜索结果会显示在这里</div>}
      </div></ScrollArea>
    </section>
  );
}
