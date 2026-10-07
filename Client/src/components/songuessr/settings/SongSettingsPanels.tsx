/* eslint-disable react-refresh/only-export-components -- 折叠组摘要与面板读同一份设置口径，放在一起改动时不会漏掉一边。 */
import { useRef, useState } from "react";
import { Disc3, Globe, ListMusic, Lock, Mic2, Tv, Users, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import type { SegmentedOption } from "@/components/ui/SegmentedControl";
import { SearchCombobox, SearchOptionContent, type SearchStatus } from "@/components/common/SearchCombobox";
import {
  SettingReveal, SettingScaleSlider, SettingSegmented, SettingStepper, SettingSwitchRow, SettingTextField, SettingToggleChips,
  SettingValue, SettingYearRange, SettingsFields, SettingsSection, useSettingsReadOnly,
} from "@/components/common/room/SettingFields";
import { useAutoSave } from "@/hooks/UseAutoSave";
import { listItem } from "@/lib/Motion";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { ALL_BANGUMI_TRACK_KINDS, BANGUMI_TRACK_KIND_LABELS } from "@/types";
import type {
  AnimeAutoFilters,
  BangumiMusicTrackKind,
  SongArtistFilter,
  SongArtistSearchResult,
  SonGuessrRoomSnapshot,
} from "@/types";

const QUESTION_TYPE_OPTIONS: SegmentedOption<SonGuessrRoomSnapshot["settings"]["questionType"]>[] = [
  { value: "song", label: "听歌识曲" },
  { value: "anime", label: "听歌识番" },
];
const QUESTION_MODE_OPTIONS: SegmentedOption<SonGuessrRoomSnapshot["settings"]["questionMode"]>[] = [
  { value: "manual", label: "手动出题" },
  { value: "automatic", label: "自动出题" },
];
const RANKING_OPTIONS: SegmentedOption<NonNullable<AnimeAutoFilters["ranking"]>>[] = [
  { value: "all", label: "总榜" },
  { value: "year", label: "年榜" },
];
// 网易云热度门槛的刻度：0 为不限，越往后间距越大（前段百、千级细调，后段十万级大步），上限 1000000。
// 滑动条只会回写其中一档；服务端按 0–1000000 校验，不认档位。
const POPULARITY_STOPS = [
  0, 500, 1_000, 2_000, 3_000, 5_000, 7_500, 10_000, 15_000, 20_000, 30_000, 50_000,
  75_000, 100_000, 150_000, 200_000, 300_000, 500_000, 750_000, 1_000_000,
] as const;
const POPULARITY_MAJORS = [1_000, 10_000, 100_000] as const;
const popularityValue = (value: number) => (value === 0 ? "不限" : `${value.toLocaleString("zh-CN")}+`);
/** 刻度标注用中文数量级缩写，挤在轨道下方也读得清。 */
const popularityTick = (value: number) =>
  value === 0 ? "不限" : value >= 10_000 ? `${value / 10_000} 万` : `${value / 1_000} 千`;
const TRACK_KIND_OPTIONS = ALL_BANGUMI_TRACK_KINDS.map((kind) => ({ value: kind, label: BANGUMI_TRACK_KIND_LABELS[kind] }));
const popularityText = (value: number) => (value === 0 ? "不限热度" : `热度 ${value.toLocaleString("zh-CN")}+`);

// 阶段切换会直接卸载等待设置树，旧 props 的 enabled 来不及变为 false。
// 三类设置共用发送边界：防抖、卸载刷新和飞行中后续草稿都以当前房间阶段为准。
async function saveWaitingSettings(roomId: string, payload: Record<string, unknown>) {
  const state = useSonGuessrStore.getState();
  if (state.snapshot?.roomId !== roomId || state.snapshot.phase !== "waiting") return;
  await state.sendCommand("song.room.updateSettings", payload);
}

/** 题目设置的取值：非房主直接读快照，房主的草稿也从它起步。 */
const questionOf = (snapshot: SonGuessrRoomSnapshot) => ({
  questionType: snapshot.settings.questionType,
  questionMode: snapshot.settings.questionMode,
  autoRotateSubmitter: snapshot.settings.autoRotateSubmitter,
  playlist: snapshot.settings.autoFilters.playlist,
  artists: snapshot.settings.autoFilters.artists,
  minPopularity: snapshot.settings.autoFilters.minPopularity,
  animeFilters: snapshot.settings.animeAutoFilters ?? {},
});
type QuestionDraft = ReturnType<typeof questionOf>;

/**
 * 题目设置：题型与出题方式，手动出题时的轮流开关，自动出题时按题型出现的筛选小节。
 * 非房主看到同一份结构（`readOnly`），读的是当前快照；房主改动防抖后自动保存。
 */
export function SongQuestionSettings({
  snapshot,
  solo = false,
  readOnly = false,
}: {
  snapshot: SonGuessrRoomSnapshot;
  solo?: boolean;
  readOnly?: boolean;
}) {
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const [draft, setDraft] = useState(() => questionOf(snapshot));
  const values = readOnly ? questionOf(snapshot) : draft;
  const edit = <K extends keyof QuestionDraft>(key: K, value: QuestionDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const editAnime = (patch: Partial<AnimeAutoFilters>) => setDraft((current) => ({ ...current, animeFilters: { ...current.animeFilters, ...patch } }));

  useAutoSave(
    {
      questionType: draft.questionType,
      questionMode: draft.questionMode,
      autoRotateSubmitter: draft.autoRotateSubmitter,
      autoFilters: { playlist: draft.playlist, artists: draft.artists, minPopularity: draft.minPopularity },
      animeAutoFilters: draft.animeFilters,
    },
    (payload) => saveWaitingSettings(snapshot.roomId, payload),
    {
      enabled: !readOnly && snapshot.phase === "waiting",
      onError: (error) =>
        setNotice((error as { message?: string }).message ?? "保存设置失败", "error"),
    },
  );

  const automatic = values.questionMode === "automatic";
  return (
    <div>
      <SettingsSection>
        <SettingSegmented label="题目类型" value={values.questionType} options={QUESTION_TYPE_OPTIONS} onValueChange={(value) => edit("questionType", value)} />
        {!solo ? (
          <SettingSegmented label="出题方式" value={values.questionMode} options={QUESTION_MODE_OPTIONS} onValueChange={(value) => edit("questionMode", value)}
            description={automatic ? "每轮按下面的筛选从网易云或番剧曲库自动抽题。" : "每轮由一位玩家搜索并选定题目。"} />
        ) : null}
        <SettingReveal open={!automatic}>
          <SettingSwitchRow label="自动轮流出题" description="每轮按玩家加入顺序自动指定下一位出题人。"
            checked={values.autoRotateSubmitter} onCheckedChange={(value) => edit("autoRotateSubmitter", value)} />
        </SettingReveal>
      </SettingsSection>

      <SettingsSection title="曲库筛选" icon={ListMusic} open={automatic && values.questionType === "song"}>
        <SongAutoFilters values={values} edit={edit} />
      </SettingsSection>

      <SettingsSection title="番剧筛选" icon={Tv} open={automatic && values.questionType === "anime"}>
        <AnimeFilters filters={values.animeFilters} onChange={editAnime} />
      </SettingsSection>
    </div>
  );
}

/** 已选条目：可移除的胶囊，进出按 `listItem` 推入淡出。歌单与歌手共用。 */
/**
 * 已选筛选项的标签：纸面小卡片，左侧图标标明种类（歌单 / 歌手），右侧以细分隔线隔出独立的移除格。
 * 移除格整格可点、悬停转为危险色，不再是挤在胶囊里的小圆钮。
 */
function FilterChip({ icon: Icon, label, removeLabel, onRemove }: {
  icon: typeof X;
  label: string;
  removeLabel: string;
  onRemove?: () => void;
}) {
  return (
    <motion.span variants={listItem} initial="initial" animate="animate" exit="exit" layout="position"
      className="inline-flex h-7 max-w-full items-stretch overflow-hidden rounded-md border border-border bg-card text-xs shadow-2xs">
      <span className="flex min-w-0 items-center gap-1.5 pr-2 pl-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate" title={label}>{label}</span>
      </span>
      {onRemove ? (
        <button type="button" aria-label={removeLabel} onClick={onRemove}
          className="flex w-7 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none">
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </motion.span>
  );
}

/**
 * 听歌识曲的自动出题筛选：歌单（粘贴链接后读取）、歌手（浮动搜索多选）与热度档位，任一项都可单独使用。
 * 只读时三项都写成一行取值。
 */
function SongAutoFilters({ values, edit }: {
  values: QuestionDraft;
  edit: <K extends keyof QuestionDraft>(key: K, value: QuestionDraft[K]) => void;
}) {
  const readOnly = useSettingsReadOnly();
  const searchArtist = useSonGuessrStore((state) => state.searchArtist);
  const resolvePlaylistQuery = useSonGuessrStore((state) => state.resolvePlaylist);
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const [playlistDraft, setPlaylistDraft] = useState(values.playlist?.id ?? "");
  const [resolvingPlaylist, setResolvingPlaylist] = useState(false);
  const [artistDraft, setArtistDraft] = useState("");
  const [artistResults, setArtistResults] = useState<{ key: string; items: SongArtistSearchResult[] } | null>(null);
  const [searchingArtists, setSearchingArtists] = useState(false);
  const [artistError, setArtistError] = useState("");
  const request = useRef(0);

  if (readOnly) {
    return (
      <>
        <SettingValue label="歌单" value={values.playlist ? `${values.playlist.name ?? values.playlist.id}（${values.playlist.songCount ?? "?"} 首）` : "网易云热歌榜"} />
        <SettingValue label="歌手" value={values.artists.length ? values.artists.map((artist) => artist.name).join("、") : "不限"} />
        <SettingValue label="热度筛选" value={popularityText(values.minPopularity)} />
      </>
    );
  }

  const resolvePlaylist = async () => {
    if (resolvingPlaylist || !playlistDraft.trim()) return;
    setResolvingPlaylist(true);
    try {
      // 走 store 封装：同一份链接在复用窗口内不会重复请求上游。
      const result = await resolvePlaylistQuery(playlistDraft);
      edit("playlist", result);
      setNotice(`已读取歌单：${result.name}（${result.songCount} 首）`, "success");
    } catch (error) {
      setNotice((error as { message?: string }).message ?? "读取歌单失败", "error");
    } finally {
      setResolvingPlaylist(false);
    }
  };

  const searchArtists = async () => {
    const keyword = artistDraft.trim();
    if (!keyword) return;
    const id = ++request.current;
    setSearchingArtists(true);
    setArtistError("");
    try {
      const items = await searchArtist(keyword);
      if (id === request.current) setArtistResults({ key: `artists-${id}`, items });
    } catch (error) {
      if (id === request.current) setArtistError((error as { message?: string }).message ?? "搜索歌手失败");
    } finally {
      if (id === request.current) setSearchingArtists(false);
    }
  };

  const chosen = new Set(values.artists.map((artist) => artist.id));
  const items = artistResults?.items ?? [];
  const status: SearchStatus | null = artistError ? { tone: "error", text: artistError }
    : searchingArtists && !items.length ? { tone: "busy", text: "正在搜索歌手" }
      : artistResults && !searchingArtists && !items.length ? { tone: "info", text: "没有找到这位歌手" }
        : null;
  const toggleArtist = (artist: SongArtistFilter) =>
    edit("artists", chosen.has(artist.id) ? values.artists.filter((item) => item.id !== artist.id) : [...values.artists, { id: artist.id, name: artist.name }]);

  return (
    <>
      <div className="grid gap-2">
        <SettingTextField label="歌单" value={playlistDraft} onChange={setPlaylistDraft} placeholder="粘贴网易云歌单链接或 ID"
          action={(
            <Button type="button" variant="outline" className="h-10 shrink-0" disabled={resolvingPlaylist || !playlistDraft.trim()}
              loading={resolvingPlaylist} onClick={() => void resolvePlaylist()}>
              {resolvingPlaylist ? "读取中" : "读取"}
            </Button>
          )} />
        {/* 胶囊退场完才变空，空了就不占网格的间距。 */}
        <div className="flex empty:hidden">
          <AnimatePresence initial={false}>
            {values.playlist ? (
              <FilterChip key={values.playlist.id} icon={ListMusic} label={`${values.playlist.name ?? values.playlist.id} · ${values.playlist.songCount ?? "?"} 首`}
                removeLabel="清除歌单筛选" onRemove={() => { edit("playlist", undefined); setPlaylistDraft(""); }} />
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      <div className="grid gap-2">
        <span className="text-sm leading-snug">歌手<span className="text-muted-foreground">（可多选）</span></span>
        <SearchCombobox
          value={artistDraft}
          onValueChange={(value) => { setArtistDraft(value); if (!value.trim()) setArtistResults(null); }}
          label="搜索歌手"
          placeholder="输入歌手名后搜索"
          maxLength={60}
          onSubmit={() => void searchArtists()}
          busy={searchingArtists && items.length > 0}
          actions={<Button type="button" variant="outline" disabled={!artistDraft.trim()} onClick={() => void searchArtists()}>搜索</Button>}
          options={items}
          getKey={(artist) => artist.id}
          renderOption={(artist) => <SearchOptionContent title={artist.name} trailing={chosen.has(artist.id) ? "已选" : undefined} />}
          onSelect={toggleArtist}
          listKey={artistResults?.key ?? "artists"}
          status={status}
        />
        <div className="flex flex-wrap gap-1.5 empty:hidden">
          <AnimatePresence initial={false}>
            {values.artists.map((artist) => (
              <FilterChip key={artist.id} icon={Mic2} label={artist.name} removeLabel={`移除歌手 ${artist.name}`}
                onRemove={() => edit("artists", values.artists.filter((item) => item.id !== artist.id))} />
            ))}
          </AnimatePresence>
        </div>
      </div>

      <SettingScaleSlider label="热度筛选" value={values.minPopularity} stops={POPULARITY_STOPS} majors={POPULARITY_MAJORS}
        format={popularityValue} formatTick={popularityTick}
        onChange={(value) => edit("minPopularity", value)}
        description={!values.playlist && !values.artists.length
          ? "未设歌单和歌手时从网易云热歌榜出题。超高热度可能是近似值，按接口返回值判断。"
          : "超高热度可能是近似值，按接口返回值判断。"} />
    </>
  );
}

/** 听歌识番的自动出题筛选：年份、榜单与数量、网易云热度和歌曲类型。 */
function AnimeFilters({ filters, onChange }: { filters: AnimeAutoFilters; onChange: (patch: Partial<AnimeAutoFilters>) => void }) {
  return (
    <>
      <SettingYearRange label="年份范围" optional start={filters.startYear} end={filters.endYear}
        onChange={(startYear, endYear) => onChange({ startYear, endYear })} />
      <SettingSegmented label="热度范围" value={filters.ranking ?? "all"} options={RANKING_OPTIONS} onValueChange={(ranking) => onChange({ ranking })} />
      <SettingStepper label="作品数量" unit="部" value={filters.subjectLimit ?? 50} minimum={1} maximum={1000} step={10}
        format={(value) => `前 ${value} 部`} onChange={(subjectLimit) => onChange({ subjectLimit })} />
      <SettingScaleSlider label="网易云歌曲热度" value={filters.songMinPopularity ?? 0} stops={POPULARITY_STOPS} majors={POPULARITY_MAJORS}
        format={popularityValue} formatTick={popularityTick}
        onChange={(value) => onChange({ songMinPopularity: value })} />
      <SettingToggleChips<BangumiMusicTrackKind> label="歌曲类型筛选" options={TRACK_KIND_OPTIONS}
        selected={filters.trackKinds ?? ALL_BANGUMI_TRACK_KINDS} onChange={(trackKinds) => onChange({ trackKinds })} />
    </>
  );
}

const gameOf = (snapshot: SonGuessrRoomSnapshot) => ({
  lyricsLineCount: snapshot.settings.lyricsLineCount,
  showLyrics: snapshot.settings.showLyrics,
  maxGuessesPerRound: snapshot.settings.maxGuessesPerRound,
  guessDurationSeconds: snapshot.settings.guessDurationSeconds,
  showGuessTimer: snapshot.settings.showGuessTimer,
  bloodMode: snapshot.settings.bloodMode,
});

/** 猜测设置：歌词、次数、时限与血战。键名即协议字段，草稿原样保存。 */
export function SongGameSettings({
  snapshot,
  solo = false,
  readOnly = false,
}: {
  snapshot: SonGuessrRoomSnapshot;
  solo?: boolean;
  readOnly?: boolean;
}) {
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const [draft, setDraft] = useState(() => gameOf(snapshot));
  const values = readOnly ? gameOf(snapshot) : draft;
  const edit = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft((current) => ({ ...current, [key]: value }));

  useAutoSave(draft, (payload) => saveWaitingSettings(snapshot.roomId, payload), {
    enabled: !readOnly && snapshot.phase === "waiting",
    onError: (error) =>
      setNotice((error as { message?: string }).message ?? "保存设置失败", "error"),
  });

  return (
    <SettingsFields>
      <SettingSwitchRow label="显示歌词" description="关闭后只播放音乐，不显示歌词提示。" checked={values.showLyrics} onCheckedChange={(value) => edit("showLyrics", value)} />
      <SettingReveal open={values.showLyrics}>
        <SettingStepper label="歌词行数" unit="行" value={values.lyricsLineCount} minimum={1} maximum={10} onChange={(value) => edit("lyricsLineCount", value)} />
      </SettingReveal>
      <SettingStepper label="猜测次数" unit="次" value={values.maxGuessesPerRound} minimum={1} maximum={10} onChange={(value) => edit("maxGuessesPerRound", value)} />
      <SettingSwitchRow label="猜测时限" description="关闭后本轮不会倒计时。" checked={values.showGuessTimer} onCheckedChange={(value) => edit("showGuessTimer", value)} />
      <SettingReveal open={values.showGuessTimer}>
        <SettingStepper label="每次猜测时限" unit="秒" value={values.guessDurationSeconds} minimum={10} maximum={180} step={10} onChange={(value) => edit("guessDurationSeconds", value)} />
      </SettingReveal>
      {!solo ? (
        <SettingSwitchRow label="血战模式" description="首位答对获得正式玩家数分，之后每位答对者依次少 1 分。" checked={values.bloodMode} onCheckedChange={(value) => edit("bloodMode", value)} />
      ) : null}
    </SettingsFields>
  );
}

const roomOf = (snapshot: SonGuessrRoomSnapshot) => ({
  name: snapshot.name,
  isPrivate: snapshot.visibility === "private",
  password: "",
  allowSpectators: snapshot.allowSpectators,
});

/** 房间设置：名称、私密与密码、旁观。非房主只看到名称、公开与否和旁观，看不到密码。 */
export function SongRoomSettings({
  snapshot,
  readOnly = false,
}: {
  snapshot: SonGuessrRoomSnapshot;
  readOnly?: boolean;
}) {
  const setNotice = useSonGuessrStore((state) => state.setNotice);
  const [draft, setDraft] = useState(() => roomOf(snapshot));
  const values = readOnly ? roomOf(snapshot) : draft;
  const edit = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft((current) => ({ ...current, [key]: value }));

  useAutoSave(
    {
      name: draft.name || undefined,
      visibility: draft.isPrivate ? "private" : "public",
      password: draft.isPrivate ? draft.password || undefined : "",
      allowSpectators: draft.allowSpectators,
    },
    (payload) => saveWaitingSettings(snapshot.roomId, payload),
    {
      enabled:
        !readOnly &&
        snapshot.phase === "waiting" &&
        (!draft.isPrivate || snapshot.hasPassword || draft.password.trim().length > 0),
      onError: (error) =>
        setNotice((error as { message?: string }).message ?? "保存设置失败", "error"),
    },
  );

  return (
    <SettingsFields>
      <SettingTextField label="房间名称" value={values.name} maxLength={40} placeholder="输入房间名称" onChange={(value) => edit("name", value)} />
      <SettingSwitchRow label="私密房间" icon={values.isPrivate ? Lock : Globe} checked={values.isPrivate} onCheckedChange={(value) => edit("isPrivate", value)} />
      {!readOnly ? (
        <SettingReveal open={values.isPrivate}>
          {/* 还没有密码时留空不会保存（私密房间必须有密码），占位文案按是否已有密码区分。 */}
          <SettingTextField label="房间密码" type="password" value={draft.password} onChange={(value) => edit("password", value)}
            placeholder={snapshot.hasPassword ? "留空则保留当前密码" : "设置房间密码"} />
        </SettingReveal>
      ) : null}
      <SettingSwitchRow label="允许旁观" icon={Users} checked={values.allowSpectators} onCheckedChange={(value) => edit("allowSpectators", value)} />
    </SettingsFields>
  );
}

/** 三个折叠组收起时的摘要，取自已保存的快照：房主改动防抖保存后随广播更新。 */
export function songSettingsSummary(snapshot: SonGuessrRoomSnapshot) {
  const { settings } = snapshot;
  const anime = settings.animeAutoFilters ?? {};
  const automatic = settings.questionMode === "automatic";
  return {
    question: [
      settings.questionType === "anime" ? "听歌识番" : "听歌识曲",
      snapshot.solo ? "" : automatic ? "自动出题" : settings.autoRotateSubmitter ? "手动轮流出题" : "手动出题",
      automatic && settings.questionType === "song"
        ? settings.autoFilters.playlist ? `歌单 ${settings.autoFilters.playlist.name ?? settings.autoFilters.playlist.id}` : "热歌榜"
        : "",
      automatic && settings.questionType === "anime" ? `${anime.ranking === "year" ? "年榜" : "总榜"}前 ${anime.subjectLimit ?? 50} 部` : "",
    ],
    game: [
      settings.showLyrics ? `${settings.lyricsLineCount} 行歌词` : "不显示歌词",
      `${settings.maxGuessesPerRound} 次猜测`,
      settings.showGuessTimer ? `每次 ${settings.guessDurationSeconds} 秒` : "不限时",
      snapshot.solo ? "" : settings.bloodMode ? "血战模式" : "",
    ],
    room: [snapshot.visibility === "private" ? "私密房间" : "公开房间", snapshot.allowSpectators ? "允许旁观" : "不允许旁观"],
  };
}

/** 对局中顶部的自动出题筛选摘要：听歌识曲。 */
export function SongAutoFilterSummary({ snapshot }: { snapshot: SonGuessrRoomSnapshot }) {
  const filters = snapshot.settings.autoFilters;
  return (
    <FilterSummary icon={ListMusic} items={[
      filters.playlist ? `歌单：${filters.playlist.name ?? filters.playlist.id}` : "默认热歌榜",
      ...filters.artists.map((artist) => `歌手：${artist.name}`),
      popularityText(filters.minPopularity),
    ]} />
  );
}

/** 对局中顶部的自动出题筛选摘要：听歌识番。 */
export function AnimeAutoFilterSummary({ snapshot }: { snapshot: SonGuessrRoomSnapshot }) {
  const filters = snapshot.settings.animeAutoFilters ?? {};
  const kinds = filters.trackKinds && filters.trackKinds.length > 0 && filters.trackKinds.length < ALL_BANGUMI_TRACK_KINDS.length
    ? filters.trackKinds.map((kind) => BANGUMI_TRACK_KIND_LABELS[kind] ?? kind).join("、")
    : "";
  return (
    <FilterSummary icon={Disc3} items={[
      "番剧作品",
      filters.startYear || filters.endYear ? `${filters.startYear ?? "不限"}-${filters.endYear ?? "不限"}` : "",
      `${filters.ranking === "year" ? "年榜" : "总榜"}前${filters.subjectLimit ?? 50}部`,
      kinds ? `歌曲 ${kinds}` : "",
      `网易云热度 ≥ ${popularityValue(filters.songMinPopularity ?? 0)}`,
    ]} />
  );
}

function FilterSummary({ icon: Icon, items }: { icon: typeof ListMusic; items: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs">
      <span className="flex items-center gap-1 font-medium text-primary"><Icon className="h-3.5 w-3.5" aria-hidden="true" />自动出题筛选</span>
      {items.filter(Boolean).map((item) => <Badge key={item} variant="outline">{item}</Badge>)}
    </div>
  );
}
