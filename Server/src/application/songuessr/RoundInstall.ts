import {
  AUDIO_READY_GRACE_MS,
  MAX_RECENT_SONG_WINDOW,
  cloneSettings,
  type SonGuessrRoomRecord,
  type SonGuessrRoundPlayerState,
} from "./Records";
import { AppError } from "../../domain/Errors";
import type {
  BangumiMusicTrack,
  BangumiSubjectDetails,
  SongDetails,
  SongLyricClip,
} from "../../shared/Index";
import type { SonGuessrContext } from "./Context";
import { createSongLyricClip } from "./LyricClip";
import { songTitleNames } from "./LyricTitleGuard";
import { activePlayers, appendSystemMessage } from "./RoomAccess";
import { clearRoundMarks, teammateIds } from "./RoundParticipants";

/**
 * 把一首歌装成新回合：算出作答单元、切歌词片段、写近期曲目窗口并进入猜歌阶段。
 * 出题人提交与系统自动选曲共用这一处，回合从这里开始。返回新回合的轮次号。
 */
export const installRound = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  song: SongDetails,
  submitterPlayerId: string,
  anime?: BangumiSubjectDetails,
  animeTrack?: BangumiMusicTrack,
  /** 手动出题选定的片段；缺省时按房间设置自动切片。 */
  lyricClipOverride?: SongLyricClip,
  /**
   * 自动选曲时被抽中的候选 ID。取曲可能经聚合器跨平台兜底，返回的 `song.id` 与候选 ID 不一致，
   * 候选和实际播放的歌都要记，否则兜底成功的歌永远不会被排除，反复被抽中。
   */
  recordedSongId?: string
): number => {
  // 席位预约只在「下一轮开始」的转移点生效（点再来一轮进入选出题人时），这里不应用：
  // 选出题人与选歌已经属于本轮，交歌这一刻再把人切成旁观等于在本轮中间换席位。
  if (!room.solo && activePlayers(room).filter((candidate) => candidate.online).length < 2) {
    throw new AppError("NOT_ENOUGH_PLAYERS", "下一轮至少需要两名在线正式玩家");
  }
  // 随机切片优先避开唱出歌名的区间；猜番题的答案是番剧而不是曲名，不做这层回避。
  const lyricClip =
    lyricClipOverride ??
    createSongLyricClip(
      song.lyrics,
      room.settings.lyricsLineCount,
      ctx.random,
      song.durationMs,
      anime ? undefined : songTitleNames(song)
    );
  const roundNumber = room.roundNumber + 1;
  const roundSettings = cloneSettings(room.settings);
  const observerIds = teammateIds(room, submitterPlayerId);
  const units = new Map<string, SonGuessrRoundPlayerState>();
  const participantStates: Record<string, SonGuessrRoundPlayerState> = {};
  const audioReady: Record<string, boolean> = {};
  for (const candidate of activePlayers(room)) {
    if (observerIds.includes(candidate.id)) continue;
    // 出题人与人机各自单独一份：出题人（测试房以外）不作答，人机开局即放弃，都不能拖累所在队伍。
    const key =
      candidate.team === null || candidate.isBot || candidate.id === submitterPlayerId
        ? candidate.id
        : `team:${candidate.team}`;
    let unit = units.get(key);
    if (!unit) {
      unit = {
        memberIds: [],
        guessesUsed: candidate.isBot ? roundSettings.maxGuessesPerRound : 0,
        correct: false,
        gaveUp: candidate.isBot,
        ...(candidate.isBot ? { bot: true as const } : {}),
      };
      units.set(key, unit);
    }
    unit.memberIds.push(candidate.id);
    participantStates[candidate.id] = unit;
    audioReady[candidate.id] = candidate.isBot;
  }
  // 逐轮结果只描述本轮：安装新回合时先清空，结算时再把本轮的结局写回去。
  clearRoundMarks(room);
  room.roundNumber = roundNumber;
  room.currentRound = {
    number: roundNumber,
    submitterPlayerId,
    song,
    anime,
    animeTrack,
    lyricClip,
    attempts: [],
    correctPlayerIds: [],
    answererBreakdown: [],
    startScores: Object.fromEntries(
      Object.values(room.players).map((candidate) => [candidate.id, candidate.score])
    ),
    players: participantStates,
    audioReady,
    observerIds,
    settings: roundSettings,
    audioPreparationDeadlineAt: ctx.now() + AUDIO_READY_GRACE_MS,
    audioReadyDeadlineAt: undefined,
    hardDeadlineAt: undefined,
    startedAt: ctx.now(),
  };
  room.pendingSubmitterPlayerId = undefined;
  room.pendingSubmitterDeadlineAt = undefined;
  room.pendingSubmitterAssignedAt = undefined;
  room.submitterPrompt = undefined;
  room.roundSummary = undefined;
  room.phase = "playing";

  const recentSongIds = room.recentSongIds ?? [];
  // 写入时固定存满上限，窗口长度只在读取时取：单次候选池偏小或穿插一轮手动出题，
  // 都不能把长窗口的历史截短。
  const recordedIds = [...new Set([recordedSongId ?? song.id, song.id])];
  room.recentSongIds = [
    ...recordedIds,
    ...recentSongIds.filter((id) => !recordedIds.includes(id)),
  ].slice(0, MAX_RECENT_SONG_WINDOW);
  if (anime) {
    const recentSubjectIds = room.recentSubjectIds ?? [];
    room.recentSubjectIds = [anime.id, ...recentSubjectIds.filter((id) => id !== anime.id)].slice(
      0,
      10
    );
  }

  appendSystemMessage(ctx, room, `第 ${roundNumber} 轮开始`);
  return roundNumber;
};
