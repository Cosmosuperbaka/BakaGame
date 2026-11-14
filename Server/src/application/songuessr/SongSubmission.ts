import { AppError } from "../../domain/Errors";
import type { SongClipPreview, SongClipRange } from "../../shared/Index";
import type { SonGuessrContext } from "./Context";
import { resolveAnimeSong } from "./AnimeAutoPick";
import { resolveSpecifiedAnimeSong } from "./AnimeManualList";
import { createManualLyricClip, createSongLyricClip } from "./LyricClip";
import { songTitleNames } from "./LyricTitleGuard";
import { requireMusicQuota } from "./MusicCommands";
import { loadSongWithSources } from "./MusicSongLoading";
import type { SongCommandAt } from "./RoomAccess";
import { finishRound, isRoundComplete } from "./RoundEngine";
import { extendSubmitterDeadline } from "./RoundFlow";
import { installRound } from "./RoundInstall";

/**
 * 出题人预览自己选中的歌：完整音频地址与逐字歌词，用于片段编辑器。
 *
 * 只允许当前待出题人调用，且猜歌阶段一律拒绝：否则猜测者可以借这个命令拿到答案的
 * 歌词与试听。
 */
export async function getSongClipPreview(
  ctx: SonGuessrContext,
  at: SongCommandAt,
  songId: string,
  sources?: readonly string[],
  requiresVip?: boolean
): Promise<{ song: SongClipPreview }> {
  const { room, seat: player } = at;
  requireMusicQuota(ctx, at);
  const submitterId = player.id;
  const { song, alternateSongIds } = await loadSongWithSources(
    ctx,
    room,
    songId,
    sources,
    requiresVip
  );
  if (
    room.phase !== "submittingSong" ||
    room.pendingSubmitterPlayerId !== submitterId ||
    room.players[submitterId] !== player
  ) {
    throw new AppError("NOT_SUBMITTER", "出题人已变更，请重新选歌");
  }
  // 与自动抽题共用同一套切片：编辑器的默认区间就是「不手动改会播的那一段」。
  const suggested = createSongLyricClip(
    song.lyrics,
    room.settings.lyricsLineCount,
    ctx.random,
    song.durationMs,
    songTitleNames(song)
  );
  return {
    song: {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      pictureUrl: song.pictureUrl,
      durationMs: song.durationMs,
      audioUrl: song.audioUrl,
      lyrics: song.lyrics,
      chorus: song.chorus,
      sources: [song.id, ...alternateSongIds],
      requiresVip: song.requiresVip,
      suggestedClip: { startTime: suggested.startTime, endTime: suggested.endTime },
    },
  };
}

export async function submitSong(
  ctx: SonGuessrContext,
  at: SongCommandAt,
  songId: string,
  clip?: SongClipRange,
  sources?: readonly string[],
  requiresVip?: boolean
) {
  const { room, seat: player } = at;
  const submitterId = player.id;
  // 按下选歌即视为还在出题：时限顺延，慢一点的上游回源不该被巡检判成弃题。
  extendSubmitterDeadline(ctx, room);
  const { song, alternateSongIds } = await loadSongWithSources(
    ctx,
    room,
    songId,
    sources,
    requiresVip
  );
  // 音乐接口是异步的，返回时出题人可能已经退出或被踢；不能再安装一个失去归属的回合。
  if (
    room.phase !== "submittingSong" ||
    room.pendingSubmitterPlayerId !== submitterId ||
    room.players[submitterId] !== player ||
    player.membership === "kicked" ||
    !player.online
  ) {
    return { ignored: true };
  }
  // 不再按会员状态拦截会员专享曲：`getSong` 已经负责把受限歌曲交给解灰链路取回完整音频，
  // 拿不到地址时会直接抛 `SONG_UNAVAILABLE`，出题资格以「实际有没有音频」为准。
  const roundNumber = installRound(
    ctx,
    room,
    song,
    player.id,
    undefined,
    undefined,
    // 关闭自选片段后忽略客户端带来的区间，与没传片段完全一致。
    createManualLyricClip(song, room.settings.allowCustomClip === false ? undefined : clip)
  );
  if (room.currentRound?.number === roundNumber) {
    room.currentRound.alternateSongIds = alternateSongIds;
  }
  ctx.touch(room);
  ctx.publishRoom(room);
  ctx.publishLobby();

  if (isRoundComplete(ctx, room)) {
    finishRound(ctx, room);
    ctx.publishRoom(room);
  }
  return { roundNumber };
}

export async function submitAnime(
  ctx: SonGuessrContext,
  at: SongCommandAt,
  subjectId: string,
  songId?: string
) {
  const { room, seat: player } = at;
  const provider = ctx.options.bangumiProvider;
  if (!provider) throw new AppError("BANGUMI_API_UNAVAILABLE", "当前未配置 Bangumi 接口");
  const submitterId = player.id;
  extendSubmitterDeadline(ctx, room);
  const anime = await provider.getSubject(subjectId, { waitForImage: true });
  const resolved = songId
    ? await resolveSpecifiedAnimeSong(ctx, room, anime, songId)
    : await resolveAnimeSong(ctx, room, anime);
  if (
    room.phase !== "submittingSong" ||
    room.pendingSubmitterPlayerId !== submitterId ||
    room.players[submitterId] !== player ||
    player.membership === "kicked" ||
    !player.online
  )
    return { ignored: true };
  const roundNumber = installRound(ctx, room, resolved.song, player.id, anime, resolved.track);
  ctx.touch(room);
  ctx.publishRoom(room);
  ctx.publishLobby();
  if (isRoundComplete(ctx, room)) {
    finishRound(ctx, room);
    ctx.publishRoom(room);
  }
  return { roundNumber };
}
