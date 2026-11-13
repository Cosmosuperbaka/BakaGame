import type {
  BangumiSubjectDetails,
  BangumiSubjectSearchResult,
  SongDetails,
  SongSearchResult,
  SonGuessrMusicPoolView,
  SonGuessrPlayerView,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
  SonGuessrRoomSummary,
  SonGuessrRoundSummary,
  SonGuessrScore,
} from "../../shared/Index";
import { audioTicketUrl } from "./AudioTicket";
import { hasEnabledPoolAccount, isCoolingDown, musicPool, primaryPoolEntry } from "./MusicAccounts";
import type { SonGuessrPlayerRecord, SonGuessrRoomRecord } from "./Records";
import type { SonGuessrContext } from "./Context";
import { canTestSubmitterGuess, activePlayers, isTestRoom } from "./RoomAccess";
import { ensureRoundPlayerState, submitterCandidates } from "./RoundParticipants";

/** 猜歌房间快照、玩家视图与私有状态的构建：只读 ctx 状态，不发副作用。 */
export const buildRoomSummary = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord
): SonGuessrRoomSummary => {
  const activeCount = Object.values(room.players).filter(
    (player) => player.membership === "active" && player.online
  ).length;
  const spectatorCount = Object.values(room.players).filter(
    (player) => player.membership === "spectator" && player.online
  ).length;
  return {
    roomId: room.id,
    name: room.name,
    visibility: room.visibility,
    allowSpectators: room.allowSpectators,
    hasPassword: Boolean(room.passwordHash),
    playerCount: activeCount,
    spectatorCount,
    onlineCount: activeCount + spectatorCount,
    phase: room.phase,
    questionType: room.settings.questionType,
    allowAgents: room.settings.allowAgents === true,
  };
};

/**
 * 池内每号的运行状态视图：房主据此看谁的号在用、谁被摘了。
 *
 * 只带 `account` 这份可公开展示的资料，**不带 `cookie`**：池里的凭据只留在服务端内存，
 * 快照要发给房里的每个人，凭据进快照就等于把玩家登录态广播出去（见 `Server/docs/`账号约束）。
 */
export const buildMusicPoolView = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord
): SonGuessrMusicPoolView[] => {
  const now = ctx.now();
  return musicPool(room)
    .slice()
    .sort((left, right) => {
      if (left.platform !== right.platform) return left.platform === "qq" ? 1 : -1;
      if (left.addedAt !== right.addedAt) return left.addedAt - right.addedAt;
      return left.playerId.localeCompare(right.playerId);
    })
    .map((entry) => ({
      playerId: entry.playerId,
      playerName: room.players[entry.playerId]?.name ?? "已离开的玩家",
      platform: entry.platform,
      account: entry.account,
      enabled: entry.enabled,
      // 只下发还在生效的冷却：过期时间发给客户端只会让面板永远显示「冷却中」。
      ...(isCoolingDown(entry, now) ? { cooldownUntil: entry.cooldownUntil } : {}),
      inFlight: entry.inFlight,
      recentOk: entry.recentOk,
      recentTotal: entry.recentTotal,
      ...(entry.lastFailureReason !== undefined
        ? { lastFailureReason: entry.lastFailureReason }
        : {}),
    }));
};

export const buildRoomSnapshot = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord
): SonGuessrRoomSnapshot => {
  const round = room.currentRound;
  return {
    roomId: room.id,
    name: room.name,
    solo: room.solo,
    visibility: room.visibility,
    allowSpectators: room.allowSpectators,
    hasPassword: Boolean(room.passwordHash),
    hostPlayerId: room.hostPlayerId,
    testMode: isTestRoom(ctx, room),
    musicAccountReady: hasEnabledPoolAccount(ctx, room, "netease"),
    qqMusicAccountReady: hasEnabledPoolAccount(ctx, room, "qq"),
    musicAccounts: {
      netease: primaryPoolEntry(ctx, room, "netease")?.account,
      qq: primaryPoolEntry(ctx, room, "qq")?.account,
    },
    musicPool: buildMusicPoolView(ctx, room),
    settings: room.settings,
    phase: room.phase,
    roundNumber: room.roundNumber,
    pendingSubmitterPlayerId: room.pendingSubmitterPlayerId,
    submitterPrompt: room.submitterPrompt,
    currentRound:
      room.phase === "playing" && round
        ? {
            roundNumber: round.number,
            submitterPlayerId: round.submitterPlayerId,
            audioUrl: audioTicketUrl(ctx.options.publicBaseUrl, room.id, round),
            lyricClip: room.settings.showLyrics
              ? round.lyricClip
              : { ...round.lyricClip, lines: [] },
          }
        : undefined,
    players: Object.values(room.players)
      .filter((player) => player.membership !== "kicked")
      .sort((left, right) => left.joinedAt - right.joinedAt)
      .map((player) => buildPlayerView(ctx, room, player)),
    chat: room.chat,
    ...(room.roundSummary
      ? { roundSummary: buildRoundSummaryView(ctx, room, room.roundSummary) }
      : {}),
    ...(room.finalScores ? { finalScores: room.finalScores } : {}),
  };
};

/**
 * 结算摘要的下发形态：揭晓之后答案已公开，但播放不能中断，所以摘要里的播放地址与猜题阶段
 * 是同一个站内地址。地址每次现算而不存进摘要：摘要会随快照落盘，票据却不落盘；
 * 摘要里即便残留了上游地址也会被这里覆盖，不会原样发出去。
 */
const buildRoundSummaryView = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  summary: SonGuessrRoundSummary
): SonGuessrRoundSummary => ({
  ...summary,
  song: {
    ...summary.song,
    audioUrl: room.currentRound
      ? audioTicketUrl(ctx.options.publicBaseUrl, room.id, room.currentRound)
      : undefined,
  },
});

export const buildPlayerView = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  player: SonGuessrPlayerRecord
): SonGuessrPlayerView => {
  ensureRoundPlayerState(ctx, room, player);
  const round = room.currentRound;
  const state = round?.players[player.id];
  let roundStatus: SonGuessrPlayerView["roundStatus"] = "waiting";
  if (round?.submitterPlayerId === player.id) roundStatus = "submitter";
  else if (player.membership === "spectator") roundStatus = "spectator";
  else if (round?.observerIds.includes(player.id)) roundStatus = "observing";
  else if (state?.correct)
    roundStatus = round?.correctPlayerIds.includes(player.id) ? "correct" : "teamCorrect";
  else if (
    state &&
    (state.gaveUp ||
      state.guessesUsed >= (round?.settings.maxGuessesPerRound ?? room.settings.maxGuessesPerRound))
  )
    roundStatus = "finished";
  else if (room.phase === "playing" && state) roundStatus = "guessing";

  return {
    id: player.id,
    name: player.name,
    score: player.score,
    team: player.team,
    membership: player.membership,
    nextRoundMembership: player.nextRoundMembership,
    online: player.online,
    isReady: player.isReady,
    isBot: player.isBot,
    ...(player.isAgent ? { isAgent: true } : {}),
    ...(ctx.connections.isAgentDriven(player.connectionId) ? { mcpControlled: true } : {}),
    isHost: room.hostPlayerId === player.id,
    account: player.account,
    correctGuesses: player.correctGuesses,
    totalGuesses: player.totalGuesses,
    roundMarks: player.roundMarks,
    roundStatus,
    guessesUsed: state?.guessesUsed ?? 0,
  };
};

export const buildPrivateState = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  player: SonGuessrPlayerRecord
): SonGuessrPrivateState => {
  ensureRoundPlayerState(ctx, room, player);
  const round = room.currentRound;
  const state = round?.players[player.id];
  const isSubmitter =
    round?.submitterPlayerId === player.id || room.pendingSubmitterPlayerId === player.id;
  const teamObserver = room.phase === "playing" && Boolean(round?.observerIds.includes(player.id));
  const canParticipateAsGuesser =
    (!isSubmitter || canTestSubmitterGuess(ctx, room, player.id)) && !teamObserver;
  const canObserveAllAttempts = isSubmitter || teamObserver || player.membership === "spectator";
  const seesAnswer = isSubmitter || teamObserver || player.membership === "spectator";
  // 候选名单逐人重算观战队友是 O(n²)，私有状态又按连接逐个生成：只给房主、只在手动出题的等待与选人阶段算。
  const needsCandidates =
    player.id === room.hostPlayerId &&
    !room.solo &&
    (room.phase === "choosingSubmitter" ||
      (room.phase === "waiting" && room.settings.questionMode === "manual"));
  return {
    playerId: player.id,
    sessionToken: player.sessionToken,
    isSubmitter,
    teamObserver,
    submitterCandidateIds: needsCandidates
      ? submitterCandidates(ctx, room).map((candidate) => candidate.id)
      : [],
    canSubmitSong: room.phase === "submittingSong" && room.pendingSubmitterPlayerId === player.id,
    canGuess:
      room.phase === "playing" &&
      player.membership === "active" &&
      canParticipateAsGuesser &&
      Boolean(state && round?.audioReady[player.id]) &&
      !state?.correct &&
      !state?.gaveUp &&
      (state?.guessesUsed ?? 0) <
        (round?.settings.maxGuessesPerRound ?? room.settings.maxGuessesPerRound),
    canGiveUp:
      room.phase === "playing" &&
      player.membership === "active" &&
      canParticipateAsGuesser &&
      Boolean(state) &&
      !state?.inFlight &&
      !state?.correct &&
      !state?.gaveUp &&
      (state?.guessesUsed ?? 0) <
        (round?.settings.maxGuessesPerRound ?? room.settings.maxGuessesPerRound),
    remainingGuesses: Math.max(
      0,
      (round?.settings.maxGuessesPerRound ?? room.settings.maxGuessesPerRound) -
        (state?.guessesUsed ?? 0)
    ),
    guessDeadlineAt: state?.deadlineAt,
    // 出题人、出题人的队友与旁观者在游戏中均可看到本题答案
    submittedSong: seesAnswer && round ? publicSong(round.song) : undefined,
    submittedAnime: seesAnswer && round?.anime ? publicAnime(round.anime) : undefined,
    // 猜歌玩家看得到本队的全部猜测（队伍共用记录），看不到别队的
    visibleAttempts: round
      ? round.attempts.filter(
          (attempt) =>
            canObserveAllAttempts ||
            attempt.playerId === player.id ||
            Boolean(state?.memberIds.includes(attempt.playerId))
        )
      : [],
  };
};

/** 大厅列表：测试房与单人房不外露，按房号排序。 */
export const listRoomSummaries = (ctx: SonGuessrContext): SonGuessrRoomSummary[] =>
  [...ctx.rooms.values()]
    .filter((room) => !isTestRoom(ctx, room) && !room.solo)
    .map((room) => buildRoomSummary(ctx, room))
    .sort((left, right) => left.roomId.localeCompare(right.roomId));

export const buildScores = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  startScores: Record<string, number>
): SonGuessrScore[] => {
  return activePlayers(room)
    .map((player) => ({
      playerId: player.id,
      playerName: player.name,
      score: player.score,
      delta: player.score - (startScores[player.id] ?? player.score),
      correctGuesses: player.correctGuesses,
      totalGuesses: player.totalGuesses,
    }))
    .sort(
      (left, right) => right.score - left.score || left.playerName.localeCompare(right.playerName)
    );
};

export const publicSong = (song: SongDetails): SongSearchResult => {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    pictureUrl: song.pictureUrl,
    durationMs: song.durationMs,
    requiresVip: song.requiresVip,
  };
};

export const publicAnime = (anime: BangumiSubjectDetails): BangumiSubjectSearchResult => {
  return {
    id: anime.id,
    name: anime.name,
    nameCn: anime.nameCn,
    imageUrl: anime.imageUrl,
    year: anime.year,
    rating: anime.rating,
    ratingCount: anime.ratingCount,
    tags: anime.tags.filter((tag) => !tag.includes("20")).slice(0, 5),
    metaTags: [],
  };
};
