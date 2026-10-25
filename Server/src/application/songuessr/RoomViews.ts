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
  SonGuessrScore,
} from "../../shared/Index";
import { hasEnabledPoolAccount, isCoolingDown, musicPool, primaryPoolEntry } from "./MusicAccounts";
import type { SonGuessrPlayerRecord, SonGuessrRoomRecord } from "./Records";
import type { SonGuessrServiceInternals } from "./ServiceInternals";

export const buildRoomSummary = (
  service: SonGuessrServiceInternals,
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
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord
): SonGuessrMusicPoolView[] => {
  const now = service.now();
  return musicPool(service, room)
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
      ...(isCoolingDown(service, entry, now) ? { cooldownUntil: entry.cooldownUntil } : {}),
      inFlight: entry.inFlight,
      recentOk: entry.recentOk,
      recentTotal: entry.recentTotal,
      ...(entry.lastFailureReason !== undefined
        ? { lastFailureReason: entry.lastFailureReason }
        : {}),
    }));
};

export const buildRoomSnapshot = (
  service: SonGuessrServiceInternals,
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
    testMode: service.isTestRoom(room),
    musicAccountReady: hasEnabledPoolAccount(service, room, "netease"),
    qqMusicAccountReady: hasEnabledPoolAccount(service, room, "qq"),
    musicAccounts: {
      netease: primaryPoolEntry(service, room, "netease")?.account,
      qq: primaryPoolEntry(service, room, "qq")?.account,
    },
    musicPool: buildMusicPoolView(service, room),
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
            audioUrl: round.song.audioUrl,
            lyricClip: room.settings.showLyrics
              ? round.lyricClip
              : { ...round.lyricClip, lines: [] },
          }
        : undefined,
    players: Object.values(room.players)
      .filter((player) => player.membership !== "kicked")
      .sort((left, right) => left.joinedAt - right.joinedAt)
      .map((player) => buildPlayerView(service, room, player)),
    chat: room.chat,
    ...(room.roundSummary ? { roundSummary: room.roundSummary } : {}),
    ...(room.finalScores ? { finalScores: room.finalScores } : {}),
  };
};

export const buildPlayerView = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  player: SonGuessrPlayerRecord
): SonGuessrPlayerView => {
  service.ensureRoundPlayerState(room, player);
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
    ...(service.mcpSeats.isControlled(room.id, player.id) ? { mcpControlled: true } : {}),
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
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  player: SonGuessrPlayerRecord
): SonGuessrPrivateState => {
  service.ensureRoundPlayerState(room, player);
  const round = room.currentRound;
  const state = round?.players[player.id];
  const isSubmitter =
    round?.submitterPlayerId === player.id || room.pendingSubmitterPlayerId === player.id;
  const teamObserver = room.phase === "playing" && Boolean(round?.observerIds.includes(player.id));
  const canParticipateAsGuesser =
    (!isSubmitter || service.canTestSubmitterGuess(room, player.id)) && !teamObserver;
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
    ...(service.mcpSeats.isControlled(room.id, player.id) ? { mcpControlled: true } : {}),
    isSubmitter,
    teamObserver,
    submitterCandidateIds: needsCandidates
      ? service.submitterCandidates(room).map((candidate) => candidate.id)
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
    submittedSong: seesAnswer && round ? publicSong(service, round.song) : undefined,
    submittedAnime: seesAnswer && round?.anime ? publicAnime(service, round.anime) : undefined,
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

export const buildScores = (
  service: SonGuessrServiceInternals,
  room: SonGuessrRoomRecord,
  startScores: Record<string, number>
): SonGuessrScore[] => {
  return service
    .activePlayers(room)
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

export const publicSong = (
  service: SonGuessrServiceInternals,
  song: SongDetails
): SongSearchResult => {
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

export const publicAnime = (
  service: SonGuessrServiceInternals,
  anime: BangumiSubjectDetails
): BangumiSubjectSearchResult => {
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
