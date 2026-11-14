import { AppError } from "../../domain/Errors";
import { normalizeWord } from "../../domain/Rules";
import { assertTextAllowed } from "../../infrastructure/SensitiveText";
import { SONG_TEAM_BOUNDS } from "../../shared/SettingBounds";
import { normalizeAnimeAutoFilters, normalizeAutoFilters } from "./AutomaticRounds";
import { normalizeRoomPassword, type SonGuessrContext } from "./Context";
import { cloneSettings, type SonGuessrRoomRecord, type SongUpdateSettingsPayload } from "./Records";
import type { SongCommandAt } from "./RoomAccess";
import { isRoomStarting } from "./RoundFlow";

export function requestSync(ctx: SonGuessrContext, { connection, room }: SongCommandAt) {
  connection.resetStateSync?.();
  ctx.publishRoom(room, connection);
  return { synced: true };
}

export function setReady(ctx: SonGuessrContext, at: SongCommandAt, ready: boolean) {
  const { room, seat: player } = at;
  player.isReady = player.id === room.hostPlayerId ? true : ready;
  ctx.touch(room);
  ctx.publishRoom(room);
  return { ready: player.isReady };
}

export function setSpectator(ctx: SonGuessrContext, at: SongCommandAt, spectator: boolean) {
  const { room, seat: player } = at;
  if (room.phase !== "waiting") {
    const targetMembership = spectator ? "spectator" : "active";
    if (targetMembership === "spectator" && !room.allowSpectators) {
      throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
    }
    // 再次点击同个预约选项时撤销预约
    if (player.nextRoundMembership === targetMembership) {
      player.nextRoundMembership = undefined;
      ctx.touch(room);
      ctx.publishRoom(room);
      return { spectator: player.membership === "spectator", queued: false };
    }
    player.nextRoundMembership = targetMembership;
    ctx.touch(room);
    ctx.publishRoom(room);
    return { spectator, queued: true };
  }
  const nextMembership = spectator ? "spectator" : "active";
  player.nextRoundMembership = undefined;
  if (player.membership === nextMembership) return { spectator, queued: false };
  if (spectator) {
    if (!room.allowSpectators) throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
    player.membership = "spectator";
    player.isReady = false;
    // 旁观者没有队伍：回到玩家组时从个人游玩开始。
    player.team = null;
  } else {
    player.membership = "active";
    player.isReady = player.id === room.hostPlayerId;
  }
  ctx.touch(room);
  ctx.publishRoom(room);
  ctx.publishLobby();
  return { spectator, queued: false };
}

/** 选队伍：只在等待阶段、只给参与玩家，与 CEE 的 `cee.player.team` 同口径。准备状态保留。 */
export function setTeam(ctx: SonGuessrContext, at: SongCommandAt, team: number | null) {
  const { room, seat: player } = at;
  if (
    team !== null &&
    (!Number.isInteger(team) || team < SONG_TEAM_BOUNDS.min || team > SONG_TEAM_BOUNDS.max)
  ) {
    throw new AppError(
      "INVALID_TEAM",
      `队伍号只能是 ${SONG_TEAM_BOUNDS.min}–${SONG_TEAM_BOUNDS.max}`
    );
  }
  player.team = team;
  ctx.touch(room);
  ctx.publishRoom(room);
  return { team };
}

export async function updateSettings(
  ctx: SonGuessrContext,
  at: SongCommandAt,
  payload: SongUpdateSettingsPayload
) {
  const { room } = at;
  const next = { ...room, settings: cloneSettings(room.settings) };
  await applyRoomAdmission(ctx, next, payload);
  // 口令摘要要跨 await：期间房间可能已开局或关闭，回来先复核再整块覆盖。
  assertSettingsEditable(ctx, room);
  applyRoundSettings(ctx, next, room.solo, payload);

  room.name = next.name;
  room.visibility = next.visibility;
  room.passwordHash = next.passwordHash;
  room.allowSpectators = next.allowSpectators;
  room.settings = next.settings;
  ctx.touch(room);
  ctx.publishRoom(room);
  ctx.publishLobby();
  return { settings: room.settings };
}

/**
 * 设置只在「等待且没有开局在途」时可改。开局加载期间阶段仍是 waiting，
 * 只看阶段会放过题型或出题方式的改动，让回合按旧条件选歌却克隆新设置。
 * 这里是跨 await 回来后的复核；入口处的同一判定由命令表的守卫承担。
 */
function assertSettingsEditable(ctx: SonGuessrContext, room: SonGuessrRoomRecord) {
  if (ctx.rooms.get(room.id) !== room) throw new AppError("ROOM_NOT_FOUND", "房间已经关闭");
  if (room.phase !== "waiting" || isRoomStarting(room)) {
    throw new AppError("INVALID_PHASE", "只能在等待阶段修改房间设置");
  }
}

/** 先算出公开/私密的密码归属再校验，校验失败时 room 上还没有任何写入。 */
async function applyRoomAdmission(
  ctx: SonGuessrContext,
  next: Pick<SonGuessrRoomRecord, "name" | "visibility" | "passwordHash" | "allowSpectators">,
  payload: SongUpdateSettingsPayload
) {
  if (payload.name !== undefined) {
    assertTextAllowed(payload.name);
    next.name = normalizeWord(payload.name) || next.name;
  }
  if (payload.visibility !== undefined) next.visibility = payload.visibility;
  if (payload.allowSpectators !== undefined) next.allowSpectators = payload.allowSpectators;
  if (payload.visibility === "public") next.passwordHash = undefined;
  // 留空保留原口令，给了新值才换摘要：明文只在这段局部变量里存在一次。
  const password = normalizeRoomPassword(payload.password ?? "");
  if (next.visibility === "private" && password) {
    next.passwordHash = await ctx.passwords.hash(password);
  }
  if (next.visibility === "private" && !next.passwordHash) {
    throw new AppError("PASSWORD_REQUIRED", "私密房间需要密码");
  }
}

/** 单人房固定由系统出题，不提供手动出题与轮流出题。 */
function applyRoundSettings(
  ctx: SonGuessrContext,
  next: Pick<SonGuessrRoomRecord, "settings">,
  solo: boolean,
  payload: SongUpdateSettingsPayload
) {
  const { settings } = next;
  if (payload.questionType !== undefined) settings.questionType = payload.questionType;
  if (!solo && payload.questionMode !== undefined) settings.questionMode = payload.questionMode;
  if (!solo && payload.autoRotateSubmitter !== undefined) {
    settings.autoRotateSubmitter = payload.autoRotateSubmitter;
  }
  if (!solo && payload.allowCustomClip !== undefined) {
    settings.allowCustomClip = payload.allowCustomClip;
  }
  if (payload.autoFilters !== undefined)
    settings.autoFilters = normalizeAutoFilters(ctx, payload.autoFilters);
  if (payload.animeAutoFilters !== undefined) {
    settings.animeAutoFilters = normalizeAnimeAutoFilters(payload.animeAutoFilters);
  }
  if (payload.lyricsLineCount !== undefined) settings.lyricsLineCount = payload.lyricsLineCount;
  if (payload.showLyrics !== undefined) settings.showLyrics = payload.showLyrics;
  if (payload.maxGuessesPerRound !== undefined) {
    settings.maxGuessesPerRound = payload.maxGuessesPerRound;
  }
  if (payload.guessDurationSeconds !== undefined) {
    settings.guessDurationSeconds = payload.guessDurationSeconds;
  }
  if (payload.showGuessTimer !== undefined) settings.showGuessTimer = payload.showGuessTimer;
  if (payload.bloodMode !== undefined) settings.bloodMode = payload.bloodMode;
  if (payload.allowAgents !== undefined) settings.allowAgents = payload.allowAgents;
  if (payload.spectatorsSeeAnswers !== undefined) {
    settings.spectatorsSeeAnswers = payload.spectatorsSeeAnswers;
  }
}
