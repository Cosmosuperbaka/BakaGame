import {
  ackResults,
  assemble,
  avatarOf,
  button,
  control,
  inputPrefixOf,
  isHostOf,
  isRecord,
  list,
  loadSearch,
  openSubjectResults,
  playerName,
  recordList,
  requireSearch,
  screenSections,
  searchResultAt,
  selfOf,
  settingsOf,
  str,
  teamSelect,
  textbox,
  waitSearchDebounce,
  youBase,
  type UiContext,
  type UiSearchState,
} from "./Support";
import type { UiControl, UiScreen } from "./Types";

const MIN_CLIP_MS = 5_000;

const PHASE_TITLES: Record<string, string> = {
  waiting: "等待开始",
  choosingSubmitter: "指定出题人",
  submittingSong: "选择本局题目",
  playing: "听歌作答",
  roundResult: "答案揭晓",
};

const questionType = (context: UiContext): "song" | "anime" =>
  settingsOf(context).questionType === "anime" ? "anime" : "song";

const questionMode = (context: UiContext): "manual" | "automatic" =>
  settingsOf(context).questionMode === "automatic" ? "automatic" : "manual";

const hasMusic = (context: UiContext): boolean =>
  context.snapshot.musicAccountReady === true || context.snapshot.qqMusicAccountReady === true;

const currentRound = (context: UiContext): Record<string, unknown> | undefined => {
  const round = context.snapshot.currentRound;
  return isRecord(round) ? round : undefined;
};

const songPlayers = (snapshot: Record<string, unknown>) =>
  recordList(snapshot.players).map((player) => ({
    id: player.id,
    name: player.name,
    score: player.score,
    team: player.team,
    membership: player.membership,
    online: player.online,
    isReady: player.isReady,
    isBot: player.isBot,
    isAgent: player.isAgent,
    mcpControlled: player.mcpControlled,
    isHost: player.isHost,
    roundStatus: player.roundStatus,
    guessesUsed: player.guessesUsed,
    correctGuesses: player.correctGuesses,
    totalGuesses: player.totalGuesses,
    roundMarks: player.roundMarks,
    ...avatarOf(player),
  }));

const searchHint = (context: UiContext, prefix: string): string =>
  prefix.startsWith("song.submit")
    ? questionType(context) === "anime"
      ? "先搜番剧；点开一部番剧后再点关联曲提交"
      : "停止输入后自动检索；点一条结果进入片段确认"
    : "停止输入后自动检索；点一条结果即提交猜测";

/** 本人已猜过的条目编号：猜歌取 guessedSong，猜番取 guessedAnime。 */
const guessedIds = (context: UiContext, field: "guessedSong" | "guessedAnime"): string[] =>
  list(context.privateState.visibleAttempts)
    .filter(isRecord)
    .filter((attempt) => attempt.playerId === context.privateState.playerId)
    .flatMap((attempt) => {
      const target = isRecord(attempt[field]) ? attempt[field] : undefined;
      return typeof target?.id === "string" ? [target.id] : [];
    });

const songResultView = (song: Record<string, unknown>): Record<string, unknown> => ({
  id: song.id,
  title: song.title,
  artist: song.artist,
  album: song.album,
  durationMs: song.durationMs,
  pictureUrl: song.pictureUrl,
  popularity: song.popularity,
  requiresVip: song.requiresVip === true,
  sources: song.sources,
  playable: song.playable !== false,
  ...(typeof song.unplayableReason === "string" ? { unplayableReason: song.unplayableReason } : {}),
});

const subjectResultView = (subject: Record<string, unknown>): Record<string, unknown> => ({
  id: subject.id,
  name: subject.name,
  nameCn: subject.nameCn,
  imageUrl: subject.imageUrl,
  year: subject.year,
  rating: subject.rating,
  ratingCount: subject.ratingCount,
  tags: subject.tags,
  metaTags: subject.metaTags,
});

const searchResultView = (
  result: Record<string, unknown>,
  kind: UiSearchState["kind"]
): Record<string, unknown> => {
  if (kind === "song") return songResultView(result);
  if (kind === "anime") {
    const candidate = isRecord(result.candidate) ? result.candidate : undefined;
    if (candidate) {
      return {
        trackKind: isRecord(candidate.track) ? candidate.track.kind : undefined,
        trackTitle: isRecord(candidate.track) ? candidate.track.title : undefined,
        ...(isRecord(candidate.song) ? songResultView(candidate.song) : {}),
      };
    }
    return subjectResultView(result);
  }
  return result;
};

const resolveDuration = (preview: Record<string, unknown>): number => {
  const lyrics = recordList(preview.lyrics);
  const lastLyricEnd = lyrics.reduce((max, line) => {
    const end = typeof line.endTime === "number" ? line.endTime : 0;
    return Math.max(max, end);
  }, 0);
  const fallback = Math.max(lastLyricEnd + 30_000, 60_000);
  const raw =
    typeof preview.durationMs === "number" && preview.durationMs > 0
      ? preview.durationMs
      : fallback;
  return Math.max(raw, MIN_CLIP_MS);
};

const clampRange = (start: number, end: number, domain: number) => {
  const maxStart = Math.max(0, domain - MIN_CLIP_MS);
  const nextStart = Math.min(maxStart, Math.max(0, Math.round(start)));
  const nextEnd = Math.min(domain, Math.max(nextStart + MIN_CLIP_MS, Math.round(end)));
  return { startTime: nextStart, endTime: nextEnd };
};

const initialClip = (preview: Record<string, unknown>) => {
  const domain = resolveDuration(preview);
  const suggested = isRecord(preview.suggestedClip) ? preview.suggestedClip : undefined;
  if (suggested && typeof suggested.startTime === "number" && typeof suggested.endTime === "number")
    return clampRange(suggested.startTime, suggested.endTime, domain);
  const chorus = isRecord(preview.chorus) ? preview.chorus : undefined;
  const firstLine = recordList(preview.lyrics)[0];
  const rawStart =
    typeof chorus?.startTime === "number"
      ? chorus.startTime
      : typeof firstLine?.time === "number"
        ? firstLine.time
        : 0;
  const rawEnd =
    typeof chorus?.endTime === "number" && chorus.endTime > rawStart
      ? chorus.endTime
      : rawStart + 15_000;
  return clampRange(rawStart, rawEnd, domain);
};

const canStart = (context: UiContext): boolean => {
  if (!hasMusic(context)) return false;
  if (context.snapshot.solo === true) return true;
  const active = recordList(context.snapshot.players).filter(
    (player) => player.membership === "active"
  );
  const nonHost = active.filter((player) => player.isHost !== true);
  const allReady = active.length >= 2 && nonHost.every((player) => player.isReady === true);
  if (!allReady) return false;
  if (questionMode(context) === "manual") {
    const candidates = list(context.privateState.submitterCandidateIds);
    if (candidates.length === 0) return false;
  }
  return true;
};

const waitingControls = (context: UiContext): UiControl[] => {
  const me = selfOf(context);
  const controls: UiControl[] = [];
  if (isHostOf(context) || context.snapshot.solo === true) {
    controls.push(
      button("song.start", "开始游戏", "game", {
        disabled: !canStart(context),
        hint: !hasMusic(context)
          ? "请先登录网易云或 QQ 音乐账号"
          : canStart(context)
            ? undefined
            : "等待其他玩家准备，或暂无可选出题人",
      })
    );
  } else if (me?.membership === "active") {
    controls.push(button("song.ready", me.isReady === true ? "取消准备" : "准备"));
  }
  if (me?.membership === "active") {
    controls.push(teamSelect("song.team", me, "同队共享猜测次数与记录"));
  }
  return controls;
};

const choosingControls = (context: UiContext): UiControl[] => {
  if (!isHostOf(context)) return [];
  const allowed = new Set(list(context.privateState.submitterCandidateIds));
  return recordList(context.snapshot.players)
    .filter((player) => allowed.has(player.id))
    .map((player) =>
      button(`song.submitter.${String(player.id)}`, `指定 ${String(player.name)}`, "game", {
        data: { playerId: player.id, team: player.team },
      })
    );
};

const searchControls = (context: UiContext, prefix: string): UiControl[] => {
  const search = context.state.search;
  const controls: UiControl[] = [
    textbox(
      `${prefix}.input`,
      prefix === "song.submit.search" ? "搜索歌曲/番剧" : "搜索猜测",
      context.state.drafts[`${prefix}.input`] ?? "",
      "game",
      {
        maxLength: 80,
        hint: searchHint(context, prefix),
      }
    ),
  ];
  if (!search || search.prefix !== prefix) return controls;
  if (search.subject) {
    controls.push(button(`${prefix}.back`, "更换番剧", "game"));
  }
  search.results.forEach((result, index) => {
    const view = searchResultView(result, search.kind);
    const id = str(view.id);
    const disabled =
      search.purpose === "song_guess"
        ? search.kind === "anime"
          ? guessedIds(context, "guessedAnime").includes(id ?? "")
          : guessedIds(context, "guessedSong").includes(id ?? "")
        : view.playable === false;
    controls.push(
      control(
        `${prefix}.result.${index}`,
        str(view.title) ?? str(view.name) ?? `结果 ${index + 1}`,
        "listitem",
        "game",
        {
          disabled,
          hint:
            typeof view.unplayableReason === "string"
              ? view.unplayableReason
              : disabled && search.purpose === "song_guess"
                ? "已经猜过这一条"
                : undefined,
          data: view,
        }
      )
    );
  });
  return controls;
};

const previewControls = (context: UiContext): UiControl[] => {
  const preview = context.state.songPreview;
  const clip = context.state.songClip;
  if (!preview || !clip) return [];
  return [
    control("song.clip.range", "截取片段", "slider", "game", {
      value: clip,
      hint: `时间轴总长 ${Math.round(resolveDuration(preview) / 1000)} 秒；用 set 设置 startTime/endTime`,
    }),
    button("song.clip.confirm", "确认出题"),
    button("song.clip.cancel", "重新选歌"),
  ];
};

const submittingControls = (context: UiContext): UiControl[] => {
  if (context.privateState.canSubmitSong !== true) return [];
  if (context.state.songPreview) return previewControls(context);
  return searchControls(context, "song.submit.search");
};

const playingControls = (context: UiContext): UiControl[] => {
  const controls: UiControl[] = [];
  const round = currentRound(context);
  if (round) {
    controls.push(
      button("song.audio.play", "播放片段", "game", {
        hint: "点击后返回本回合的片段区间；音频本身 Agent 听不到",
      })
    );
    controls.push(
      button("song.audio.retry", "重新获取音频", "game", {
        hint: "音频加载失败时使用",
      })
    );
  }
  if (context.privateState.canGuess === true) {
    controls.push(...searchControls(context, "song.guess.search"));
    controls.push(button("song.guess.giveup", "投降"));
  }
  return controls;
};

const resultControls = (context: UiContext): UiControl[] => {
  if (!isHostOf(context)) return [];
  const controls = [
    button("song.finish", context.snapshot.solo === true ? "结束本局" : "返回等待阶段"),
  ];
  const automaticNeedsMusic = questionMode(context) === "automatic" && !hasMusic(context);
  controls.push(
    button("song.nextRound", "再来一轮", "game", {
      disabled: automaticNeedsMusic,
      hint: automaticNeedsMusic ? "自动出题需要可用的音乐账号" : undefined,
    })
  );
  return controls;
};

const phaseControls = (context: UiContext): UiControl[] => {
  switch (str(context.snapshot.phase)) {
    case "waiting":
      return waitingControls(context);
    case "choosingSubmitter":
      return choosingControls(context);
    case "submittingSong":
      return submittingControls(context);
    case "playing":
      return playingControls(context);
    case "roundResult":
      return resultControls(context);
    default:
      return [];
  }
};

const audioPanel = (context: UiContext): Record<string, unknown> => {
  const round = currentRound(context);
  if (!round) return { available: false, reason: "当前不在播放回合" };
  const clip = isRecord(round.lyricClip) ? round.lyricClip : {};
  const showLyrics = settingsOf(context).showLyrics !== false;
  return {
    available: true,
    roundNumber: round.roundNumber,
    submitterPlayerId: round.submitterPlayerId,
    clip: {
      startTime: clip.startTime,
      endTime: clip.endTime,
      ...(showLyrics && Array.isArray(clip.lines) ? { lines: clip.lines } : {}),
    },
    lyricsVisible: showLyrics,
    hint: "Agent 听不到音频：只给出片段区间与歌词开关；开启歌词时线索在 clip.lines",
  };
};

const previewPanel = (context: UiContext): Record<string, unknown> | undefined => {
  const preview = context.state.songPreview;
  if (!preview) return undefined;
  return {
    id: preview.id,
    title: preview.title,
    artist: preview.artist,
    album: preview.album,
    durationMs: preview.durationMs,
    pictureUrl: preview.pictureUrl,
    lyrics: preview.lyrics,
    chorus: preview.chorus,
    suggestedClip: preview.suggestedClip,
    sources: preview.sources,
    requiresVip: preview.requiresVip === true,
    selectedClip: context.state.songClip,
  };
};

const searchPanel = (context: UiContext): Record<string, unknown> | undefined => {
  const search = context.state.search;
  if (!search) return undefined;
  return {
    prefix: search.prefix,
    keyword: search.keyword,
    kind: search.kind,
    status: search.status,
    error: search.error,
    subject: search.subject ? subjectResultView(search.subject) : undefined,
    results: search.results.map((result) => searchResultView(result, search.kind)),
  };
};

/** 结算摘要里的播放地址只对能听的人类页面有用，Agent 屏幕不带：既无用处，也不该有任何音轨地址。 */
const withoutAudioUrl = (summary: Record<string, unknown>): Record<string, unknown> => {
  if (!isRecord(summary.song)) return summary;
  const { audioUrl: _omitted, ...song } = summary.song;
  return { ...summary, song };
};

export function buildSongScreen(context: UiContext): UiScreen {
  const phase = str(context.snapshot.phase) ?? "waiting";
  const sections = screenSections("song", phaseControls(context), context);
  const roundSummary = isRecord(context.snapshot.roundSummary)
    ? withoutAudioUrl(context.snapshot.roundSummary)
    : undefined;
  return assemble(
    context,
    {
      phase,
      title: PHASE_TITLES[phase] ?? "猜歌",
      notice:
        phase === "submittingSong" && context.privateState.canSubmitSong !== true
          ? `${playerName(context.snapshot, context.snapshot.pendingSubmitterPlayerId)} 正在选歌`
          : phase === "roundResult" && !isHostOf(context)
            ? "等待房主开始下一轮"
            : undefined,
      you: {
        ...youBase(context, isHostOf(context)),
        isSubmitter: context.privateState.isSubmitter === true,
        teamObserver: context.privateState.teamObserver === true,
        canSubmitSong: context.privateState.canSubmitSong === true,
        canGuess: context.privateState.canGuess === true,
        canGiveUp: context.privateState.canGiveUp === true,
        remainingGuesses: context.privateState.remainingGuesses,
        guessDeadlineAt: context.privateState.guessDeadlineAt,
        submittedSong: context.privateState.submittedSong,
        submittedAnime: context.privateState.submittedAnime,
      },
      panel: {
        settings: context.snapshot.settings,
        roundNumber: context.snapshot.roundNumber,
        pendingSubmitterPlayerId: context.snapshot.pendingSubmitterPlayerId,
        submitterPrompt: context.snapshot.submitterPrompt,
        musicAccountReady: hasMusic(context),
        audio: audioPanel(context),
        preview: previewPanel(context),
        search: searchPanel(context),
        attempts: recordList(context.privateState.visibleAttempts),
        roundSummary,
        finalScores: context.snapshot.finalScores,
      },
      sections,
    },
    songPlayers(context.snapshot)
  );
}

const send = (context: UiContext, type: string, payload: Record<string, unknown> = {}) =>
  context.client.sendInRoom("song", type, payload, { timeoutMs: 180_000 });

const startSearch = (
  context: UiContext,
  prefix: string,
  purpose: UiSearchState["purpose"]
): UiSearchState => {
  const kind = questionType(context) === "anime" ? "anime" : "song";
  const keyword = context.state.drafts[`${prefix}.input`] ?? "";
  const search: UiSearchState = {
    prefix,
    purpose,
    kind,
    keyword,
    status: "loading",
    results: [],
  };
  context.state.search = search;
  return search;
};

const searchPurposeOf = (prefix: string): UiSearchState["purpose"] =>
  prefix === "song.submit.search" ? "song_submit" : "song_guess";

const searchCommandOf = (kind: UiSearchState["kind"]): string =>
  kind === "anime" ? "song.bangumi.search" : "song.music.search";

export async function autoSearchSong(context: UiContext, controlId: string): Promise<void> {
  const prefix = inputPrefixOf(controlId);
  if (prefix !== "song.submit.search" && prefix !== "song.guess.search") return;
  const keyword = (context.state.drafts[`${prefix}.input`] ?? "").trim();
  if (!keyword) {
    context.state.search = undefined;
    return;
  }
  // 人类页面停止输入后自动查询；这里保持同样的节拍，不额外加显式搜索按钮。
  await waitSearchDebounce();
  const search = startSearch(context, prefix, searchPurposeOf(prefix));
  // 自动检索的失败只留在搜索态里，由下面的反馈说明，不打断后续步骤。
  await loadSearch(search, () => send(context, searchCommandOf(search.kind), { keyword })).catch(
    () => undefined
  );
  if (context.state.search === search)
    context.state.lastFeedback = search.error ?? `找到 ${search.results.length} 条结果`;
}

const clearSearch = (context: UiContext) => {
  const prefix = context.state.search?.prefix;
  context.state.search = undefined;
  if (prefix) delete context.state.drafts[`${prefix}.input`];
};

const needSearch = (context: UiContext, prefix: string): UiSearchState =>
  requireSearch(context, prefix, "搜索结果已变化，请重新在搜索框输入并等待检索完成", {
    nonEmpty: true,
  });

const clickSubmitResult = async (context: UiContext, search: UiSearchState, index: string) => {
  const result = searchResultAt(search, index);
  if (search.kind === "anime" && search.subject) {
    const song = isRecord(result.song) ? result.song : undefined;
    const songId = str(song?.id);
    if (!songId) throw new Error("关联曲缺少 songId");
    const subjectId = str(search.subject.id);
    if (!subjectId) throw new Error("番剧缺少 subjectId");
    await send(context, "song.game.submitAnime", { subjectId, songId });
    clearSearch(context);
    return `已提交《${str(search.subject.nameCn) || str(search.subject.name) || "番剧"}》与关联曲`;
  }
  if (search.kind === "anime") {
    const subjectId = str(result.id);
    if (!subjectId) throw new Error("番剧缺少 subjectId");
    const ack = await send(context, "song.bangumi.songs", { subjectId });
    openSubjectResults(search, result, ack);
    return `已打开番剧的关联曲，共 ${search.results.length} 首`;
  }
  const songId = str(result.id);
  if (!songId) throw new Error("歌曲缺少 songId");
  const pick = {
    songId,
    ...(Array.isArray(result.sources) ? { sources: result.sources.map(String) } : {}),
    ...(typeof result.requiresVip === "boolean" ? { requiresVip: result.requiresVip } : {}),
  };
  if (settingsOf(context).allowCustomClip === false) {
    await send(context, "song.game.submitSong", pick);
    clearSearch(context);
    return `已出题《${str(result.title) ?? songId}》，片段由系统随机截取`;
  }
  const ack = await send(context, "song.music.detail", pick);
  const preview = isRecord(ack) && isRecord(ack.song) ? ack.song : undefined;
  if (!preview) throw new Error("歌曲详情没有返回");
  context.state.songPreview = preview;
  context.state.songClip = initialClip(preview);
  return `已选中《${str(preview.title) ?? songId}》，请确认截取片段`;
};

const clickGuessResult = async (context: UiContext, search: UiSearchState, index: string) => {
  const result = searchResultAt(search, index);
  if (search.kind === "anime") {
    const subjectId = str(result.id);
    if (!subjectId) throw new Error("番剧缺少 subjectId");
    await send(context, "song.game.guessAnime", { subjectId });
    clearSearch(context);
    return `已猜《${str(result.nameCn) || str(result.name) || subjectId}》`;
  }
  const songId = str(result.id);
  if (!songId) throw new Error("歌曲缺少 songId");
  await send(context, "song.game.guess", { songId });
  clearSearch(context);
  return `已猜《${str(result.title) ?? songId}》`;
};

const clickSongAudio = async (context: UiContext, id: string): Promise<string> => {
  const round = currentRound(context);
  if (!round) throw new Error("当前没有播放中的回合");
  if (id === "song.audio.play") {
    const clip = isRecord(round.lyricClip) ? round.lyricClip : {};
    const start = typeof clip.startTime === "number" ? clip.startTime : 0;
    const end = typeof clip.endTime === "number" ? clip.endTime : 0;
    return `本回合片段区间为 ${start}–${end} 毫秒；音频不下发给 Agent，歌词开启时见 panel.audio.clip.lines`;
  }
  const roundNumber = round.roundNumber;
  if (typeof roundNumber !== "number") throw new Error("当前没有播放中的回合");
  await send(context, "song.game.audioFailed", { roundNumber });
  return "已请求刷新音频";
};

const clickSongClip = async (context: UiContext, id: string): Promise<string> => {
  if (id === "song.clip.cancel") {
    context.state.songPreview = undefined;
    context.state.songClip = undefined;
    clearSearch(context);
    return "已取消片段确认，可以重新选歌";
  }
  const preview = context.state.songPreview;
  const clip = context.state.songClip;
  if (!preview || !clip) throw new Error("还没有选择歌曲片段");
  const songId = str(preview.id);
  if (!songId) throw new Error("歌曲缺少 songId");
  await send(context, "song.game.submitSong", {
    songId,
    clip,
    ...(Array.isArray(preview.sources) ? { sources: preview.sources.map(String) } : {}),
    ...(typeof preview.requiresVip === "boolean" ? { requiresVip: preview.requiresVip } : {}),
  });
  context.state.songPreview = undefined;
  context.state.songClip = undefined;
  clearSearch(context);
  return `已出题《${str(preview.title) ?? songId}》`;
};

const clickSongSearch = async (context: UiContext, id: string): Promise<string | undefined> => {
  for (const prefix of ["song.submit.search", "song.guess.search"]) {
    if (id === `${prefix}.back`) {
      const search = needSearch(context, prefix);
      search.subject = undefined;
      const ack = await send(context, "song.bangumi.search", { keyword: search.keyword });
      search.results = ackResults(ack);
      return "已返回番剧结果";
    }
    if (id.startsWith(`${prefix}.result.`)) {
      const search = needSearch(context, prefix);
      const index = id.slice(`${prefix}.result.`.length);
      return search.purpose === "song_submit"
        ? clickSubmitResult(context, search, index)
        : clickGuessResult(context, search, index);
    }
  }
  return undefined;
};

const clickSongBasic = async (context: UiContext, id: string): Promise<string | undefined> => {
  switch (id) {
    case "song.ready": {
      const me = selfOf(context);
      await send(context, "song.player.setReady", { ready: me?.isReady !== true });
      return me?.isReady === true ? "已取消准备" : "已准备";
    }
    case "song.start":
      await send(context, "song.game.start");
      return "已开始游戏";
    case "song.guess.giveup":
      await send(context, "song.game.giveUp");
      return "已投降";
    case "song.finish":
      await send(context, "song.game.finish");
      return "已返回等待阶段";
    case "song.nextRound":
      await send(context, "song.game.nextRound");
      return "已开始下一轮";
    default:
      return undefined;
  }
};

export async function clickSongControl(
  context: UiContext,
  controlValue: UiControl
): Promise<string> {
  const id = controlValue.id;
  if (id.startsWith("song.submitter.")) {
    const playerId = id.slice("song.submitter.".length);
    await send(context, "song.game.chooseSubmitter", { playerId });
    return `已指定 ${playerName(context.snapshot, playerId)} 出题`;
  }
  if (id.startsWith("song.audio.")) return clickSongAudio(context, id);
  if (id.startsWith("song.clip.")) return clickSongClip(context, id);
  const basic = await clickSongBasic(context, id);
  if (basic) return basic;
  const search = await clickSongSearch(context, id);
  if (search) return search;
  throw new Error(`控件「${controlValue.label}」当前不可操作`);
}

export async function setSongControl(
  context: UiContext,
  controlValue: UiControl,
  value: unknown
): Promise<string> {
  if (controlValue.id === "song.team") {
    if (value !== "none" && !/^[1-8]$/.test(String(value)))
      throw new Error("队伍必须是 1–8 或不组队");
    await send(context, "song.player.setTeam", {
      team: value === "none" ? null : Number(value),
    });
    return value === "none" ? "已退出队伍" : `已加入 ${String(value)} 队`;
  }
  if (controlValue.id === "song.clip.range") {
    if (
      !isRecord(value) ||
      typeof value.startTime !== "number" ||
      typeof value.endTime !== "number"
    )
      throw new Error("片段需要 startTime 与 endTime 两个毫秒值");
    const preview = context.state.songPreview;
    if (!preview) throw new Error("还没有选择歌曲");
    const range = clampRange(value.startTime, value.endTime, resolveDuration(preview));
    if (range.endTime - range.startTime < MIN_CLIP_MS) throw new Error("片段至少 5 秒");
    context.state.songClip = range;
    return `片段已设为 ${Math.round(range.startTime / 1000)}–${Math.round(range.endTime / 1000)} 秒`;
  }
  throw new Error(`控件「${controlValue.label}」不是可设置取值的控件`);
}

export async function pressSong(
  context: UiContext,
  controlValue: UiControl,
  key: string
): Promise<string | undefined> {
  if (key !== "Enter") return undefined;
  if (controlValue.id.endsWith(".search.input")) {
    const prefix = inputPrefixOf(controlValue.id);
    const keyword = (context.state.drafts[controlValue.id] ?? "").trim();
    if (!keyword) throw new Error("搜索词不能为空");
    const search = startSearch(context, prefix, searchPurposeOf(prefix));
    await loadSearch(search, () => send(context, searchCommandOf(search.kind), { keyword }));
    return `找到 ${search.results.length} 条结果`;
  }
  return undefined;
}

/** 进入播放回合后替玩家完成「音频已就绪」这一步；人类客户端是播放器加载完自动上报。 */
export async function ensureSongAudioReady(context: UiContext): Promise<void> {
  if (str(context.snapshot.phase) !== "playing") return;
  const round = currentRound(context);
  const roundNumber = round?.roundNumber;
  if (typeof roundNumber !== "number") return;
  if (context.state.audioReadyRound === roundNumber) return;
  const me = selfOf(context);
  if (me?.membership !== "active") return;
  if (context.privateState.canGuess !== true && context.privateState.isSubmitter !== true) return;
  context.state.audioReadyRound = roundNumber;
  try {
    await send(context, "song.game.audioReady", { roundNumber });
  } catch {
    context.state.audioReadyRound = undefined;
  }
}
