import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Globe, Lock, Minus, Plus, Users, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Switch } from "@/components/ui/Switch";
import { Badge } from "@/components/ui/Badge";
import { collapsible, pressable, spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { useAutoSave } from "@/hooks/UseAutoSave";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { BANGUMI_TRACK_KIND_LABELS } from "@/types";
import type {
  AnimeAutoFilters,
  SongArtistFilter,
  SongArtistSearchResult,
  SongPlaylistInfo,
  SonGuessrRoomSnapshot,
} from "@/types";

export function SettingsAccordion({
  icon,
  title,
  open,
  onOpenChange,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border">
      <motion.button
        type="button"
        {...pressable}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium transition-colors hover:bg-accent/40"
      >
        {icon}
        <span className="flex-1 text-left">{title}</span>
        <motion.span
          className="inline-flex text-muted-foreground"
          animate={{ rotate: open ? 180 : 0 }}
          transition={spring.snap}
        >
          <ChevronDown className="h-4 w-4" />
        </motion.span>
      </motion.button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            variants={collapsible}
            initial="initial"
            animate="animate"
            exit="exit"
            className="overflow-hidden"
          >
            <div className="border-t px-4 py-4">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function CountStepper({
  label,
  value,
  minimum,
  maximum,
  step = 1,
  onChange,
  disabled = false,
}: {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.max(minimum, Math.min(maximum, Math.round(parsed)));
    setDraft(String(next));
    onChange(next);
  };

  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => commit(String(Math.max(minimum, value - step)))}
          disabled={disabled || value <= minimum}
          aria-label={`减少${label}`}
        >
          <Minus className="h-3 w-3" />
        </Button>
        <Input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            if (event.target.value !== "") commit(event.target.value);
          }}
          onBlur={() => commit(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(draft);
          }}
          aria-label={label}
          className="h-9 w-16 bg-muted/30 px-1 text-center text-base font-medium tabular-nums shadow-inner"
        />
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => commit(String(Math.min(maximum, value + step)))}
          disabled={disabled || value >= maximum}
          aria-label={`增加${label}`}
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

export function SongQuestionSettings({
  snapshot,
  solo = false,
}: {
  snapshot: SonGuessrRoomSnapshot;
  solo?: boolean;
}) {
  const sendCommand = useSonGuessrStore((state) => state.sendCommand);
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const [questionType, setQuestionType] = useState(snapshot.settings.questionType);
  const [questionMode, setQuestionMode] = useState(snapshot.settings.questionMode);
  const [autoRotateSubmitter, setAutoRotateSubmitter] = useState(snapshot.settings.autoRotateSubmitter);
  const [playlistDraft, setPlaylistDraft] = useState(snapshot.settings.autoFilters.playlist?.id ?? "");
  const [playlist, setPlaylist] = useState(snapshot.settings.autoFilters.playlist);
  const [artistDraft, setArtistDraft] = useState("");
  const [artists, setArtists] = useState<SongArtistFilter[]>(snapshot.settings.autoFilters.artists);
  const [artistResults, setArtistResults] = useState<SongArtistSearchResult[]>([]);
  const [searchingArtists, setSearchingArtists] = useState(false);
  const [resolvingPlaylist, setResolvingPlaylist] = useState(false);
  const [minPopularity, setMinPopularity] = useState(snapshot.settings.autoFilters.minPopularity);
  const [animeFilters, setAnimeFilters] = useState<AnimeAutoFilters>(snapshot.settings.animeAutoFilters ?? {});

  const resolvePlaylist = async () => {
    if (resolvingPlaylist) return;
    setResolvingPlaylist(true);
    try {
      const result = await sendCommand<{ playlist: SongPlaylistInfo }>("song.music.playlist.resolve", {
        value: playlistDraft,
      });
      setPlaylist(result.playlist);
      setNotice(`已读取歌单：${result.playlist.name}（${result.playlist.songCount} 首）`, "success");
    } catch (error) {
      setNotice((error as { message?: string }).message ?? "读取歌单失败", "error");
    } finally {
      setResolvingPlaylist(false);
    }
  };

  const searchArtists = async () => {
    const keyword = artistDraft.trim();
    if (!keyword) return;
    setSearchingArtists(true);
    try {
      const result = await sendCommand<{ results: SongArtistSearchResult[] }>("song.music.artist.search", { keyword });
      setArtistResults(result.results);
    } catch (error) {
      setNotice((error as { message?: string }).message ?? "搜索歌手失败", "error");
    } finally {
      setSearchingArtists(false);
    }
  };

  useAutoSave(
    {
      questionType,
      questionMode,
      autoRotateSubmitter,
      autoFilters: { playlist, artists, minPopularity },
      animeAutoFilters: animeFilters,
    },
    (payload) => sendCommand("song.room.updateSettings", payload),
    {
      enabled: snapshot.phase === "waiting",
      onError: (error) =>
        setNotice((error as { message?: string }).message ?? "保存设置失败", "error"),
    },
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant={questionType === "song" ? "default" : "outline"}
          className="h-10"
          onClick={() => setQuestionType("song")}
        >
          听歌识曲
        </Button>
        <Button
          type="button"
          variant={questionType === "anime" ? "default" : "outline"}
          className="h-10"
          onClick={() => setQuestionType("anime")}
        >
          听歌识番
        </Button>
      </div>

      {!solo ? (
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={questionMode === "manual" ? "default" : "outline"}
            className="h-10"
            onClick={() => setQuestionMode("manual")}
          >
            手动出题
          </Button>
          <Button
            type="button"
            variant={questionMode === "automatic" ? "default" : "outline"}
            className="h-10"
            onClick={() => setQuestionMode("automatic")}
          >
            自动出题
          </Button>
        </div>
      ) : null}

      {questionMode === "manual" ? (
        <div className="flex items-center justify-between rounded-md bg-muted/40 p-3">
          <div>
            <Label className="text-xs">自动轮流出题</Label>
            <p className="mt-1 text-[11px] text-muted-foreground">每轮按玩家加入顺序自动指定下一位出题人。</p>
          </div>
          <Switch checked={autoRotateSubmitter} onCheckedChange={setAutoRotateSubmitter} />
        </div>
      ) : null}

      {questionMode === "automatic" && questionType === "song" ? (
        <div className="space-y-4 rounded-md bg-muted/40 p-3">
          <div className="space-y-2">
            <Label className="text-xs">歌单筛选</Label>
            <div className="flex gap-2">
              <Input
                value={playlistDraft}
                onChange={(event) => setPlaylistDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void resolvePlaylist();
                  }
                }}
                placeholder="粘贴网易云歌单链接或 ID"
                className="h-9"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={resolvingPlaylist}
                loading={resolvingPlaylist}
                onClick={() => void resolvePlaylist()}
              >
                {resolvingPlaylist ? "读取中" : "读取"}
              </Button>
            </div>
            {playlist ? (
              <div className="flex items-center justify-between gap-2 rounded border bg-background px-2.5 py-2 text-xs">
                <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                  <span className="truncate">{playlist.name ?? playlist.id}</span>
                  <span className="shrink-0 text-muted-foreground">{playlist.songCount ?? ""} 首</span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    setPlaylist(undefined);
                    setPlaylistDraft("");
                  }}
                  aria-label="清除歌单筛选"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">歌手筛选（可多选）</Label>
            <div className="flex gap-2">
              <Input
                value={artistDraft}
                onChange={(event) => setArtistDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void searchArtists();
                  }
                }}
                placeholder="输入歌手名后搜索"
                className="h-9"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={searchingArtists}
                loading={searchingArtists}
                onClick={() => void searchArtists()}
              >
                {searchingArtists ? "搜索中" : "搜索"}
              </Button>
            </div>
            {artistResults.length > 0 ? (
              <div className="space-y-1 rounded border bg-background p-2">
                {artistResults.map((artist) => {
                  const selected = artists.some((item) => item.id === artist.id);
                  return (
                    <button
                      key={artist.id}
                      type="button"
                      className={cn("flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-muted", selected && "bg-primary/10 text-primary")}
                      onClick={() => setArtists((current) => selected ? current.filter((item) => item.id !== artist.id) : [...current, { id: artist.id, name: artist.name }])}
                    >
                      <span>{artist.name}</span>
                      <span>{selected ? "已选" : "选择"}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {artists.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {artists.map((artist) => (
                  <Badge
                    key={artist.id}
                    variant="secondary"
                    className="cursor-pointer gap-1 hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setArtists((current) => current.filter((item) => item.id !== artist.id))}
                    title="点击移除歌手筛选"
                  >
                    <span>{artist.name}</span>
                    <X className="h-3 w-3" />
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">热度筛选</Label>
            <div className="grid grid-cols-4 gap-1.5">
              {([0, 1_000, 10_000, 100_000] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={minPopularity === value ? "default" : "outline"}
                  onClick={() => setMinPopularity(value)}
                >
                  {value === 0 ? "不限" : `${value}+`}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">网易云对超高热度可能返回近似值，筛选按接口返回值判断。</p>
          </div>
          {!playlist && artists.length === 0 ? (
            <p className="rounded border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
              未填写歌单和歌手时，将从网易云热歌榜中自动出题；任一筛选项都可以单独使用。
            </p>
          ) : null}
        </div>
      ) : null}

      {questionMode === "automatic" && questionType === "anime" ? (
        <div className="space-y-3 rounded-md bg-muted/40 p-3">
          <Label className="text-xs">番剧筛选</Label>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-20 text-sm text-muted-foreground">年份范围</span>
              <Input className="h-9 w-24 appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" type="number" value={animeFilters.startYear ?? ""} onChange={(e) => setAnimeFilters((f) => ({ ...f, startYear: e.target.value ? Number(e.target.value) : undefined }))} aria-label="起始年份" />
              <span className="text-muted-foreground">-</span>
              <Input className="h-9 w-24 appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" type="number" value={animeFilters.endYear ?? ""} onChange={(e) => setAnimeFilters((f) => ({ ...f, endYear: e.target.value ? Number(e.target.value) : undefined }))} aria-label="结束年份" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-20 text-sm text-muted-foreground">热度范围</span>
              <div className="flex rounded-md border bg-background p-1">
                {(["all", "year"] as const).map((ranking) => <Button key={ranking} type="button" size="sm" variant={(animeFilters.ranking ?? "all") === ranking ? "default" : "ghost"} onClick={() => setAnimeFilters((f) => ({ ...f, ranking }))}>{ranking === "all" ? "总榜" : "年榜"}</Button>)}
              </div>
              <Input className="h-9 w-24 appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" type="number" min="1" max="1000" value={animeFilters.subjectLimit ?? 50} onChange={(e) => setAnimeFilters((f) => ({ ...f, subjectLimit: e.target.value ? Number(e.target.value) : undefined }))} aria-label="作品数量" />
              <span className="text-sm text-muted-foreground">部</span>
            </div>
            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">网易云歌曲热度</Label>
              <div className="grid grid-cols-4 gap-1.5">{([0, 1_000, 10_000, 100_000] as const).map((value) => <Button key={value} type="button" size="sm" variant={(animeFilters.songMinPopularity ?? 0) === value ? "default" : "outline"} onClick={() => setAnimeFilters((f) => ({ ...f, songMinPopularity: value }))}>{value === 0 ? "不限" : `${value}+`}</Button>)}</div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SongGameSettings({
  snapshot,
  solo = false,
}: {
  snapshot: SonGuessrRoomSnapshot;
  solo?: boolean;
}) {
  const sendCommand = useSonGuessrStore((state) => state.sendCommand);
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const [showLyrics, setShowLyrics] = useState(snapshot.settings.showLyrics);
  const [bloodMode, setBloodMode] = useState(snapshot.settings.bloodMode);
  const [showGuessTimer, setShowGuessTimer] = useState(snapshot.settings.showGuessTimer);
  const [lyricsLineCount, setLyricsLineCount] = useState(snapshot.settings.lyricsLineCount);
  const [maxGuesses, setMaxGuesses] = useState(snapshot.settings.maxGuessesPerRound);
  const [guessDuration, setGuessDuration] = useState(snapshot.settings.guessDurationSeconds);

  useAutoSave(
    {
      lyricsLineCount,
      showLyrics,
      maxGuessesPerRound: maxGuesses,
      guessDurationSeconds: guessDuration,
      showGuessTimer,
      bloodMode,
    },
    (payload) => sendCommand("song.room.updateSettings", payload),
    {
      enabled: snapshot.phase === "waiting",
      onError: (error) =>
        setNotice((error as { message?: string }).message ?? "保存设置失败", "error"),
    },
  );

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs">显示歌词</Label>
            <p className="mt-1 text-[11px] text-muted-foreground">关闭后只播放音乐，不显示歌词提示。</p>
          </div>
          <Switch checked={showLyrics} onCheckedChange={setShowLyrics} />
        </div>
        {showLyrics ? (
          <CountStepper
            label="歌词行数"
            value={lyricsLineCount}
            minimum={1}
            maximum={10}
            onChange={setLyricsLineCount}
          />
        ) : null}
      </div>
      <CountStepper
        label="猜测次数"
        value={maxGuesses}
        minimum={1}
        maximum={10}
        onChange={setMaxGuesses}
      />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs">猜测时限</Label>
            <p className="mt-1 text-[11px] text-muted-foreground">关闭后本轮不会倒计时。</p>
          </div>
          <Switch checked={showGuessTimer} onCheckedChange={setShowGuessTimer} />
        </div>
        {showGuessTimer ? (
          <CountStepper
            label="每次猜测时限"
            value={guessDuration}
            minimum={10}
            maximum={180}
            step={10}
            onChange={setGuessDuration}
          />
        ) : null}
      </div>
      {!solo ? (
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs">血战模式</Label>
            <p className="mt-1 text-[11px] text-muted-foreground">首位答对获得正式玩家数分，之后每位答对者依次少 1 分。</p>
          </div>
          <Switch checked={bloodMode} onCheckedChange={setBloodMode} />
        </div>
      ) : null}
    </div>
  );
}

export function SongRoomSettings({
  snapshot,
}: {
  snapshot: SonGuessrRoomSnapshot;
}) {
  const sendCommand = useSonGuessrStore((state) => state.sendCommand);
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const [name, setName] = useState(snapshot.name);
  const [isPrivate, setIsPrivate] = useState(snapshot.visibility === "private");
  const [password, setPassword] = useState("");
  const [allowSpectators, setAllowSpectators] = useState(snapshot.allowSpectators);

  useAutoSave(
    {
      name: name || undefined,
      visibility: isPrivate ? "private" : "public",
      password: isPrivate ? password || undefined : "",
      allowSpectators,
    },
    (payload) => sendCommand("song.room.updateSettings", payload),
    {
      enabled:
        snapshot.phase === "waiting" &&
        (!isPrivate || snapshot.hasPassword || password.trim().length > 0),
      onError: (error) =>
        setNotice((error as { message?: string }).message ?? "保存设置失败", "error"),
    },
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs">房间名称</Label>
        <Input value={name} onChange={(event) => setName(event.target.value)} className="h-9" />
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isPrivate ? <Lock className="h-3.5 w-3.5 text-muted-foreground" /> : <Globe className="h-3.5 w-3.5 text-muted-foreground" />}
          <Label className="text-xs">私密房间</Label>
        </div>
        <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
      </div>
      <AnimatePresence initial={false}>
        {isPrivate ? (
          <motion.div variants={collapsible} initial="initial" animate="animate" exit="exit" className="overflow-hidden">
            <div className="space-y-1.5 pt-1">
              <Label className="text-xs">密码</Label>
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="留空则保留当前密码"
                className="h-9"
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-muted-foreground" />
          <Label className="text-xs">允许旁观</Label>
        </div>
        <Switch checked={allowSpectators} onCheckedChange={setAllowSpectators} />
      </div>
    </div>
  );
}

export function SongSettingsPreview({ snapshot }: { snapshot: SonGuessrRoomSnapshot }) {
  const items = [
    snapshot.settings.questionMode === "automatic"
      ? "自动出题"
      : snapshot.settings.autoRotateSubmitter ? "手动轮流出题" : "手动出题",
    snapshot.visibility === "private" ? "私密房间" : "公开房间",
    snapshot.allowSpectators ? "允许旁观" : "不允许旁观",
    snapshot.settings.showLyrics ? `${snapshot.settings.lyricsLineCount} 行歌词` : "歌词已关闭",
    `每人 ${snapshot.settings.maxGuessesPerRound} 次猜测`,
    snapshot.settings.showGuessTimer ? `每次 ${snapshot.settings.guessDurationSeconds} 秒` : "猜测时限已关闭",
    snapshot.settings.bloodMode ? "血战模式" : "普通模式",
  ];
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {items.map((item) => (
        <span key={item} className="rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
          {item}
        </span>
      ))}
    </div>
  );
}

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
