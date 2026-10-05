import { useEffect, useRef, useState } from "react";
import { Film, Music2 } from "lucide-react";
import type { BangumiSongCandidate, BangumiSubjectSearchResult, SongSearchResult } from "@/types";
import { BANGUMI_TRACK_KIND_LABELS } from "@/types";
import { SearchCombobox, SearchOptionContent, type SearchStatus } from "@/components/common/SearchCombobox";
import { Badge } from "@/components/ui/Badge";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { cn } from "@/lib/Utils";

/** 停止输入多久后发起查询：连续敲字时不逐字请求上游。 */
const DEBOUNCE_MS = 350;

const messageOf = (error: unknown, fallback: string) => (error as { message?: string } | null)?.message ?? fallback;

/**
 * 随输入防抖查询。新查询在途时保留上一批结果（输入框尾部转圈），晚到的旧结果一律丢弃；
 * 清空输入即视为没有结果，不需要等在途请求回来。
 */
function useKeywordSearch<T>(keyword: string, search: (keyword: string) => Promise<T[]>, fallback: string) {
  const query = keyword.trim();
  const [result, setResult] = useState<{ keyword: string; items: T[] } | null>(null);
  const [failure, setFailure] = useState<{ keyword: string; message: string } | null>(null);
  const [inFlight, setInFlight] = useState(false);

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setInFlight(true);
      try {
        const items = await search(query);
        if (!cancelled) { setResult({ keyword: query, items }); setFailure(null); }
      } catch (error) {
        if (!cancelled) setFailure({ keyword: query, message: messageOf(error, fallback) });
      } finally {
        if (!cancelled) setInFlight(false);
      }
    }, DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, search, fallback]);

  const items = query && result ? result.items : [];
  const loading = Boolean(query) && inFlight;
  return {
    items,
    loading,
    listKey: query && result ? `results:${result.keyword}` : "none",
    error: query && failure?.keyword === query ? failure.message : "",
    /** 当前关键词已查过且没有结果 */
    empty: Boolean(query) && !loading && result?.keyword === query && items.length === 0,
  };
}

/** 封面缩略图：歌曲取方形，番剧取竖版海报；没有图时用同尺寸的图标占位。 */
function Cover({ src, shape, icon: Icon }: { src?: string; shape: "square" | "poster"; icon: typeof Music2 }) {
  const size = shape === "square" ? "size-10" : "h-12 w-9";
  return src ? (
    <img src={src} alt="" loading="lazy" decoding="async" className={cn(size, "shrink-0 rounded-md bg-background object-cover")} />
  ) : (
    <span className={cn(size, "flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground")}>
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

const songDetail = (song: SongSearchResult) => [song.artist, song.album].filter(Boolean).join(" · ");

function SongRow({ song, guessed, badge }: { song: SongSearchResult; guessed?: boolean; badge?: string }) {
  return (
    <SearchOptionContent
      media={<Cover src={song.pictureUrl} shape="square" icon={Music2} />}
      title={song.title}
      subtitle={songDetail(song) || undefined}
      trailing={guessed ? "已猜过" : (
        badge || song.requiresVip ? (
          <span className="flex items-center gap-1">
            {badge ? <Badge variant="outline" size="xs">{badge}</Badge> : null}
            {song.requiresVip ? <Badge variant="restricted" size="xs">会员专享</Badge> : null}
          </span>
        ) : undefined
      )}
    />
  );
}

function SubjectRow({ subject, guessed }: { subject: BangumiSubjectSearchResult; guessed?: boolean }) {
  const detail = [
    subject.nameCn && subject.name !== subject.nameCn ? subject.name : "",
    subject.year ? String(subject.year) : "",
    subject.rating ? `${subject.rating.toFixed(1)} 分` : "",
  ].filter(Boolean).join(" · ");
  return (
    <SearchOptionContent
      media={<Cover src={subject.imageUrl} shape="poster" icon={Film} />}
      title={subject.nameCn || subject.name}
      subtitle={detail || undefined}
      trailing={guessed ? "已猜过" : undefined}
    />
  );
}

interface SearchBaseProps {
  /** `submit` 出题、`guess` 猜测：决定出题时番剧要不要再选一首关联曲 */
  mode: "submit" | "guess";
  disabled?: boolean;
  /** 自己本回合已经猜过的候选：保留在结果里但不可再选 */
  guessedIds?: readonly string[];
  className?: string;
}

/**
 * 猜歌的歌曲搜索：输入即查（防抖），结果浮在下方内容之上，点整行即提交。
 * 提交成功后清空输入，面板随之收起；失败时结果保留，错误显示在面板顶部，可以换一首再选。
 */
export function SongSearch({ mode, disabled = false, guessedIds = [], className, onSelect }: SearchBaseProps & {
  onSelect: (song: SongSearchResult) => Promise<void>;
}) {
  const searchMusic = useSonGuessrStore((state) => state.searchMusic);
  const [keyword, setKeyword] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState("");
  const search = useKeywordSearch(keyword, searchMusic, "搜索歌曲失败");

  const choose = async (song: SongSearchResult) => {
    setPendingId(song.id);
    setSubmitError("");
    try {
      await onSelect(song);
      setKeyword("");
    } catch (error) {
      setSubmitError(messageOf(error, mode === "submit" ? "提交歌曲失败" : "提交猜测失败"));
    } finally {
      setPendingId(null);
    }
  };

  const error = submitError || search.error;
  const status: SearchStatus | null = error ? { tone: "error", text: error }
    : search.loading && search.items.length === 0 ? { tone: "busy", text: "正在查询网易云音乐" }
      : search.empty ? { tone: "info", text: "没有找到匹配歌曲" }
        : null;

  return (
    <SearchCombobox
      className={className}
      value={keyword}
      onValueChange={(value) => { setKeyword(value); setSubmitError(""); }}
      label="搜索歌曲"
      placeholder="歌名、歌手或专辑"
      maxLength={80}
      disabled={disabled}
      busy={search.loading && search.items.length > 0}
      options={search.items}
      getKey={(song) => song.id}
      isOptionDisabled={(song) => guessedIds.includes(song.id)}
      renderOption={(song) => <SongRow song={song} guessed={guessedIds.includes(song.id)} />}
      onSelect={(song) => void choose(song)}
      pendingKey={pendingId}
      listKey={search.listKey}
      status={status}
    />
  );
}

type AnimeOption =
  | { kind: "subject"; subject: BangumiSubjectSearchResult }
  | { kind: "song"; candidate: BangumiSongCandidate };

const animeKey = (option: AnimeOption) => (option.kind === "subject" ? `subject:${option.subject.id}` : `song:${option.candidate.song.id}`);

/**
 * 猜番的番剧搜索。猜测时点番剧即提交；出题时点番剧进入它的关联曲列表，再点一首作为题目，
 * 列表顶上一行「更换番剧」回到番剧结果。
 */
export function AnimeSearch({ mode, disabled = false, guessedIds = [], className, onSelect }: SearchBaseProps & {
  onSelect: (subject: BangumiSubjectSearchResult, songId?: string) => Promise<void>;
}) {
  const searchBangumi = useSonGuessrStore((state) => state.searchBangumi);
  const resolveAnimeSongs = useSonGuessrStore((state) => state.resolveAnimeSongs);
  const [keyword, setKeyword] = useState("");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState("");
  /** 出题时选中的番剧与它匹配到的关联曲 */
  const [picked, setPicked] = useState<{ subject: BangumiSubjectSearchResult; songs: BangumiSongCandidate[] } | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const search = useKeywordSearch(keyword, searchBangumi, "搜索番剧失败");

  const leavePicked = () => {
    generation.current++;
    setPicked(null);
    setPendingKey(null);
    setSubmitError("");
  };

  const submit = async (key: string, subject: BangumiSubjectSearchResult, songId?: string) => {
    setPendingKey(key);
    setSubmitError("");
    try {
      await onSelect(subject, songId);
      setKeyword("");
      setPicked(null);
    } catch (error) {
      setSubmitError(messageOf(error, mode === "submit" ? "提交出题失败" : "提交番剧失败"));
    } finally {
      setPendingKey((current) => (current === key ? null : current));
    }
  };

  const openSubject = async (subject: BangumiSubjectSearchResult) => {
    const request = ++generation.current;
    const key = `subject:${subject.id}`;
    setPendingKey(key);
    setSubmitError("");
    try {
      const songs = await resolveAnimeSongs(subject.id);
      if (request === generation.current) setPicked({ subject, songs });
    } catch (error) {
      if (request === generation.current) setSubmitError(messageOf(error, "获取关联歌曲失败"));
    } finally {
      if (request === generation.current) setPendingKey(null);
    }
  };

  const options: AnimeOption[] = picked
    ? picked.songs.map((candidate) => ({ kind: "song", candidate }))
    : search.items.map((subject) => ({ kind: "subject", subject }));

  const error = submitError || (picked ? "" : search.error);
  const status: SearchStatus | null = error ? { tone: "error", text: error }
    : picked ? (picked.songs.length === 0 ? { tone: "info", text: "该番剧未匹配到可播放的关联歌曲" } : null)
      : search.loading && options.length === 0 ? { tone: "busy", text: "正在查询 Bangumi" }
        : search.empty ? { tone: "info", text: "没有找到匹配番剧" }
          : null;

  return (
    <SearchCombobox
      className={className}
      value={keyword}
      onValueChange={(value) => { setKeyword(value); leavePicked(); }}
      label="搜索番剧"
      placeholder="番剧名称或别名"
      maxLength={80}
      disabled={disabled}
      busy={!picked && search.loading && options.length > 0}
      options={options}
      getKey={animeKey}
      isOptionDisabled={(option) => option.kind === "subject" && guessedIds.includes(option.subject.id)}
      renderOption={(option) => option.kind === "subject"
        ? <SubjectRow subject={option.subject} guessed={guessedIds.includes(option.subject.id)} />
        : <SongRow song={option.candidate.song} badge={BANGUMI_TRACK_KIND_LABELS[option.candidate.track.kind] ?? option.candidate.track.kind} />}
      onSelect={(option) => {
        if (option.kind === "song") { if (picked) void submit(animeKey(option), picked.subject, option.candidate.song.id); }
        else if (mode === "submit") void openSubject(option.subject);
        else void submit(animeKey(option), option.subject);
      }}
      pendingKey={pendingKey}
      listKey={picked ? `songs:${picked.subject.id}` : search.listKey}
      status={status}
      back={picked ? { label: "更换番剧", detail: picked.subject.nameCn || picked.subject.name, onBack: leavePicked } : null}
    />
  );
}
