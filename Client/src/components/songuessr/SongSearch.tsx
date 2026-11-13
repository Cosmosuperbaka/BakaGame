import { useEffect, useRef, useState } from "react";
import { useIdleSearch } from "@/hooks/UseIdleSearch";
import { Film, Music2 } from "lucide-react";
import { BANGUMI_TRACK_KIND_LABELS } from "@bakagame/shared/values";
import type {
  BangumiSongCandidate,
  BangumiSubjectSearchResult,
  SongSearchResult,
} from "@bakagame/shared";
import { SearchCombobox } from "@/components/common/SearchCombobox";
import { SearchOptionContent, type SearchStatus } from "@/components/common/search/SearchPanel";
import { LazyImage } from "@/components/common/LazyImage";
import { Badge } from "@/components/ui/Badge";
import { Hint } from "@/components/ui/Tooltip";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { cn } from "@/lib/Utils";
import { errorMessage } from "./SongErrorMessage";
import { NeteaseCloudMusicIcon, QQMusicIcon } from "@/components/common/MusicPlatformIcons";

// 自动搜索要求稳定的错误文案函数：写在模块级，不随渲染重建。
const describeSongError = (error: unknown) => errorMessage(error, "搜索歌曲失败");
const describeAnimeError = (error: unknown) => errorMessage(error, "搜索番剧失败");

/** 封面缩略图：歌曲取方形，番剧取竖版海报；没有图时用同尺寸的图标占位。 */
function Cover({
  src,
  shape,
  icon: Icon,
}: {
  src?: string;
  shape: "square" | "poster";
  icon: typeof Music2;
}) {
  const size = shape === "square" ? "size-10" : "h-12 w-9";
  return src ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className={cn(size, "shrink-0 rounded-md bg-background object-cover")}
    />
  ) : (
    <span
      className={cn(
        size,
        "flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

const songDetail = (song: SongSearchResult) =>
  [song.artist, song.album].filter(Boolean).join(" · ");

type SongPlatform = "netease" | "qq" | "both";

/** 音源平台：取主实体的 URN；聚合器同时给出两家时算双源，提示这首有两个音源可兜底。 */
function platformOf(song: SongSearchResult): SongPlatform | null {
  const ids = song.sources?.length ? song.sources : [song.id];
  if (ids.some((id) => id.startsWith("netease:")) && ids.some((id) => id.startsWith("qq:"))) {
    return "both";
  }
  if (song.id.startsWith("qq:")) return "qq";
  return song.id.startsWith("netease:") ? "netease" : null;
}

const PLATFORM_LABEL: Record<SongPlatform, string> = {
  netease: "网易云",
  qq: "QQ音乐",
  both: "网易云 + QQ 音乐双源",
};

/** 平台只以品牌图标出现，名称走统一悬停；同一段文字也是图像角色的名称，读屏读得出。 */
function PlatformLogo({ platform }: { platform: SongPlatform }) {
  const label = PLATFORM_LABEL[platform];
  return (
    <Hint label={label}>
      <span role="img" aria-label={label} className="inline-flex items-center gap-0.5">
        {platform !== "qq" ? <NeteaseCloudMusicIcon className="size-4 shrink-0" /> : null}
        {platform !== "netease" ? <QQMusicIcon className="size-4 shrink-0" /> : null}
      </span>
    </Hint>
  );
}

function SongRow({
  song,
  guessed,
  badge,
}: {
  song: SongSearchResult;
  guessed?: boolean;
  badge?: string;
}) {
  // 不可播放的来源（目前只有「QQ 会员专享、池里没有会员账号」）：仍在列表里露头，
  // 让房主知道这首确实存在、补个会员账号就能出，而不是点下去才发现播不了。
  const unplayable = song.playable === false;
  const platform = platformOf(song);
  const platformLogo = platform ? <PlatformLogo platform={platform} /> : null;

  return (
    <SearchOptionContent
      media={<Cover src={song.pictureUrl} shape="square" icon={Music2} />}
      title={song.title}
      subtitle={songDetail(song) || undefined}
      trailing={
        guessed ? (
          "已猜过"
        ) : unplayable ? (
          <Hint label={song.unplayableReason ?? "当前账号无法播放"}>
            <span className="inline-flex items-center gap-1.5">
              {platformLogo}
              <Badge variant="outline" size="xs" className="text-muted-foreground">
                不可播放
              </Badge>
            </span>
          </Hint>
        ) : platformLogo || badge ? (
          <span className="flex items-center gap-1.5">
            {platformLogo}
            {badge ? (
              <Badge variant="outline" size="xs">
                {badge}
              </Badge>
            ) : null}
          </span>
        ) : undefined
      }
    />
  );
}

function SubjectRow({
  subject,
  guessed,
}: {
  subject: BangumiSubjectSearchResult;
  guessed?: boolean;
}) {
  const detail = [
    subject.nameCn && subject.name !== subject.nameCn ? subject.name : "",
    subject.year ? String(subject.year) : "",
    subject.rating ? `${subject.rating.toFixed(1)} 分` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <SearchOptionContent
      // 只读数据集不含图片：自带封面就直接用，没有的等滚进视口再补一次。
      media={
        <LazyImage
          cacheKey={`song-subject:${subject.id}`}
          initial={subject.imageUrl}
          className="h-12 w-9"
          fallback={<Film className="size-4" aria-hidden="true" />}
          request={async () => {
            const { imageUrl } = await useSonGuessrStore
              .getState()
              .sendCommand("song.subject.image", { subjectId: subject.id });
            return imageUrl;
          }}
        />
      }
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
export function SongSearch({
  mode,
  disabled = false,
  guessedIds = [],
  className,
  onSelect,
}: SearchBaseProps & {
  onSelect: (song: SongSearchResult) => Promise<void>;
}) {
  const searchMusic = useSonGuessrStore((state) => state.searchMusic);
  const controlPrefix = mode === "submit" ? "song.submit.search" : "song.guess.search";
  const [keyword, setKeyword] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState("");
  // 座位被 MCP 接管时由服务端驱动输入；人类页面只显示 Agent 键入的文本，不再自己发查询。
  const search = useIdleSearch(keyword, searchMusic, describeSongError);

  const choose = async (song: SongSearchResult) => {
    setPendingId(song.id);
    setSubmitError("");
    try {
      await onSelect(song);
      setKeyword("");
    } catch (error) {
      setSubmitError(errorMessage(error, mode === "submit" ? "提交歌曲失败" : "提交猜测失败"));
    } finally {
      setPendingId(null);
    }
  };

  const error = submitError || search.error;
  const status: SearchStatus | null = error
    ? { tone: "error", text: error }
    : search.loading && search.items.length === 0
      ? { tone: "busy", text: "正在搜索歌曲" }
      : search.empty
        ? { tone: "info", text: "没有找到匹配歌曲" }
        : null;

  return (
    <SearchCombobox
      className={className}
      value={keyword}
      onValueChange={(value) => {
        setKeyword(value);
        setSubmitError("");
      }}
      label="搜索歌曲"
      placeholder="歌名、歌手或专辑"
      maxLength={80}
      disabled={disabled}
      onSubmit={search.flush}
      busy={search.loading && search.items.length > 0}
      options={search.items}
      getKey={(song) => song.id}
      isOptionDisabled={(song) => song.playable === false || guessedIds.includes(song.id)}
      renderOption={(song) => <SongRow song={song} guessed={guessedIds.includes(song.id)} />}
      onSelect={(song) => void choose(song)}
      pendingKey={pendingId}
      listKey={search.listKey}
      status={status}
      agentControlId={`${controlPrefix}.input`}
      agentControlPrefix={controlPrefix}
    />
  );
}

type AnimeOption =
  | { kind: "subject"; subject: BangumiSubjectSearchResult }
  | { kind: "song"; candidate: BangumiSongCandidate };

const animeKey = (option: AnimeOption) =>
  option.kind === "subject" ? `subject:${option.subject.id}` : `song:${option.candidate.song.id}`;

/** 出题时选中的番剧与它匹配到的关联曲 */
interface PickedSubject {
  subject: BangumiSubjectSearchResult;
  songs: BangumiSongCandidate[];
}

/**
 * 猜番搜索的选择状态：在途标记、提交错误与出题时「进入某番剧的关联曲」。
 * 进入关联曲要等一次请求，期间换了番剧、离开或卸载都让旧回包作废（代际号）。
 */
function useAnimePicker({
  mode,
  onSelect,
  onSubmitted,
}: {
  mode: SearchBaseProps["mode"];
  onSelect: (subject: BangumiSubjectSearchResult, songId?: string) => Promise<void>;
  /** 提交成功后：调用方清空输入 */
  onSubmitted: () => void;
}) {
  const resolveAnimeSongs = useSonGuessrStore((state) => state.resolveAnimeSongs);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [picked, setPicked] = useState<PickedSubject | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );

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
      onSubmitted();
      setPicked(null);
    } catch (error) {
      setSubmitError(errorMessage(error, mode === "submit" ? "提交出题失败" : "提交番剧失败"));
    } finally {
      setPendingKey((current) => (current === key ? null : current));
    }
  };

  const openSubject = async (subject: BangumiSubjectSearchResult) => {
    const request = ++generation.current;
    setPendingKey(`subject:${subject.id}`);
    setSubmitError("");
    try {
      const songs = await resolveAnimeSongs(subject.id);
      if (request === generation.current) setPicked({ subject, songs });
    } catch (error) {
      if (request === generation.current) setSubmitError(errorMessage(error, "获取关联歌曲失败"));
    } finally {
      if (request === generation.current) setPendingKey(null);
    }
  };

  return { picked, pendingKey, submitError, leavePicked, submit, openSubject };
}

/** 搜索面板顶部的状态行：错误优先，其次关联曲为空、查询中与无结果。 */
function animeStatus(
  error: string,
  picked: PickedSubject | null,
  search: { loading: boolean; empty: boolean },
  optionCount: number
): SearchStatus | null {
  if (error) return { tone: "error", text: error };
  if (picked) {
    return picked.songs.length === 0
      ? { tone: "info", text: "该番剧未匹配到可播放的关联歌曲" }
      : null;
  }
  if (search.loading && optionCount === 0) return { tone: "busy", text: "正在查询 Bangumi" };
  return search.empty ? { tone: "info", text: "没有找到匹配番剧" } : null;
}

/**
 * 猜番的番剧搜索。猜测时点番剧即提交；出题时点番剧进入它的关联曲列表，再点一首作为题目，
 * 列表顶上一行「更换番剧」回到番剧结果。
 */
export function AnimeSearch({
  mode,
  disabled = false,
  guessedIds = [],
  className,
  onSelect,
}: SearchBaseProps & {
  onSelect: (subject: BangumiSubjectSearchResult, songId?: string) => Promise<void>;
}) {
  const searchBangumi = useSonGuessrStore((state) => state.searchBangumi);
  const controlPrefix = mode === "submit" ? "song.submit.search" : "song.guess.search";
  const [keyword, setKeyword] = useState("");
  const { picked, pendingKey, submitError, leavePicked, submit, openSubject } = useAnimePicker({
    mode,
    onSelect,
    onSubmitted: () => setKeyword(""),
  });
  const search = useIdleSearch(keyword, searchBangumi, describeAnimeError);

  const options: AnimeOption[] = picked
    ? picked.songs.map((candidate) => ({ kind: "song", candidate }))
    : search.items.map((subject) => ({ kind: "subject", subject }));

  const status = animeStatus(
    submitError || (picked ? "" : search.error),
    picked,
    search,
    options.length
  );

  return (
    <SearchCombobox
      className={className}
      value={keyword}
      onValueChange={(value) => {
        setKeyword(value);
        leavePicked();
      }}
      label="搜索番剧"
      placeholder="番剧名称或别名"
      maxLength={80}
      disabled={disabled}
      onSubmit={picked ? undefined : search.flush}
      busy={!picked && search.loading && options.length > 0}
      options={options}
      getKey={animeKey}
      isOptionDisabled={(option) =>
        option.kind === "subject" && guessedIds.includes(option.subject.id)
      }
      renderOption={(option) =>
        option.kind === "subject" ? (
          <SubjectRow subject={option.subject} guessed={guessedIds.includes(option.subject.id)} />
        ) : (
          <SongRow
            song={option.candidate.song}
            badge={
              BANGUMI_TRACK_KIND_LABELS[option.candidate.track.kind] ?? option.candidate.track.kind
            }
          />
        )
      }
      onSelect={(option) => {
        if (option.kind === "song") {
          if (picked) void submit(animeKey(option), picked.subject, option.candidate.song.id);
        } else if (mode === "submit") void openSubject(option.subject);
        else void submit(animeKey(option), option.subject);
      }}
      pendingKey={pendingKey}
      listKey={picked ? `songs:${picked.subject.id}` : search.listKey}
      status={status}
      agentControlId={`${controlPrefix}.input`}
      agentControlPrefix={controlPrefix}
      back={
        picked
          ? {
              label: "更换番剧",
              detail: picked.subject.nameCn || picked.subject.name,
              onBack: leavePicked,
            }
          : null
      }
    />
  );
}
