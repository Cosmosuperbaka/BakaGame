/** 显式运行的真实歌单探针；普通 bun test 不会访问网络。 */
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { SonGuessrService } from "../src/application/SonGuessrService";
import { NeteaseMusicProvider, type MusicProvider } from "../src/infrastructure/NeteaseMusicProvider";
import type { ConnectionRecord } from "../src/domain/Model";
import type { SongDetails, SongSearchResult, SonGuessrClientMessage, SonGuessrRoomSnapshot } from "../src/shared/Index";

export function measureSequence(ids: string[]) {
  const last = new Map<string, number>();
  const counts = new Map<string, number>();
  const gaps: number[] = [];
  let firstRepeatRound: number | null = null;
  ids.forEach((id, index) => {
    const previous = last.get(id);
    if (previous !== undefined) {
      gaps.push(index - previous);
      firstRepeatRound ??= index + 1;
    }
    last.set(id, index);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  });
  return {
    rounds: ids.length, unique: last.size, repeats: gaps.length,
    repeatRate: ids.length ? gaps.length / ids.length : 0,
    adjacentRepeats: gaps.filter(gap => gap === 1).length,
    recentTenRepeats: gaps.filter(gap => gap <= 10).length,
    minimumGap: gaps.length ? Math.min(...gaps) : null,
    firstRepeatRound,
    maximumAppearances: Math.max(0, ...counts.values()),
  };
}

/** 仅按完全相同的歌曲名和歌手组合统计，不推断不同录音具有相同音频。 */
export function measureSongNames(songs: SongSearchResult[], ids: string[]) {
  const names = new Map(songs.map(song => [song.id, JSON.stringify([song.title, song.artist])]));
  return measureSequence(ids.map(id => {
    const key = names.get(id);
    if (key === undefined) throw new Error("选歌序列包含歌单外曲目");
    return key;
  }));
}

// 候选数 > 10 且加载均成功时，与生产的最近十首排除策略对应的期望唯一数。
export function expectedUnique(pool: number, rounds: number, history = 10) {
  if (!pool || !rounds) return 0;
  if (pool <= history) return null;
  const initial = Math.min(rounds, history + 1);
  return pool - (pool - initial) * (1 - 1 / (pool - history)) ** (rounds - initial);
}

function fixtureSong(song: SongSearchResult): SongDetails {
  return {
    ...song, durationMs: song.durationMs ?? 180_000,
    audioUrl: "https://audio.example.test/fixture.mp3",
    encyclopedia: { tags: [] },
    lyrics: Array.from({length: 8}, (_, index) => ({
      time: index * 2_000, endTime: (index + 1) * 2_000, text: `隔离回放歌词${index}`,
    })),
  };
}

/** 使用真正的命令分发、房间状态机、默认 Math.random 和生产选歌实现。 */
export async function createProbeRoom(provider: MusicProvider, cookie: string, playlist: {id: string; name: string; songCount: number}) {
  const service = new SonGuessrService({musicProvider: provider});
  let snapshot: SonGuessrRoomSnapshot | undefined;
  const errors: string[] = [];
  const connection: ConnectionRecord = {
    id: "probe", lobbySubscribed: false, close() {},
    send(packet) {
      const event = packet as {event?: string; payload?: unknown; type?: string; error?: {code?: string}};
      if (event.type === "error") errors.push(event.error?.code ?? "UNKNOWN");
      if (event.event === "song.room.snapshot") snapshot = event.payload as SonGuessrRoomSnapshot;
    },
  };
  service.registerConnection(connection);
  let commandNumber = 0;
  const execute = (command: SonGuessrClientMessage) => service.execute(connection.id, command);
  const command = (type: "song.game.start" | "song.game.giveUp" | "song.game.nextRound") => execute({
    id: String(++commandNumber), type, roomId: "1234", payload: {},
  });
  await execute({id: "create", type: "song.room.create", payload: {
    roomId: "1234", name: "隔离随机实测", userName: "测试玩家", solo: true,
    visibility: "private", password: "isolated-probe", allowSpectators: false,
  }});
  await execute({id: "auth", type: "song.auth.useCookie", roomId: "1234", payload: {cookie}});
  await execute({id: "settings", type: "song.room.updateSettings", roomId: "1234", payload: {
    autoFilters: {playlist, artists: [], minPopularity: 0},
  }});
  let started = false;
  return {
    get lastError() { return errors.at(-1); },
    async next() {
      await command(started ? "song.game.nextRound" : "song.game.start");
      started = true;
      await command("song.game.giveUp");
      const answer = snapshot?.roundSummary?.song;
      if (!answer || snapshot?.phase !== "roundResult") throw new Error("回合未产生结算答案");
      return answer.id;
    },
    close: () => service.unregisterConnection(connection.id),
  };
}

async function main() {
  const ids = process.argv.slice(2);
  if (!ids.length || ids.some(id => !/^\d+$/.test(id))) {
    throw new Error("用法：bun run scripts/SongRandomnessProbe.ts 歌单数字ID [歌单数字ID…]");
  }
  const cookie = Bun.env.NETEASE_COOKIE?.trim();
  const liveAttempts = Number(Bun.env.SONG_PROBE_LIVE_ATTEMPTS ?? 60);
  const rooms = Number(Bun.env.SONG_PROBE_REPLAY_ROOMS ?? 100);
  const requestedLiveRounds = Number(Bun.env.SONG_PROBE_LIVE_ROUNDS ?? 60);
  const replayRounds = 100;
  if (!Number.isInteger(liveAttempts) || liveAttempts < 0 || liveAttempts > 200 ||
      !Number.isInteger(requestedLiveRounds) || requestedLiveRounds < 0 || requestedLiveRounds > 200 ||
      !Number.isInteger(rooms) || rooms < 1 || rooms > 200) {
    throw new Error("加载尝试和实测轮数须为 0—200，回放房间数须为 1—200 的整数");
  }
  const real = new NeteaseMusicProvider({enableGeneralUnblock: false});
  const report = {
    recordedAt: new Date().toISOString(),
    recordedTimeZone: "UTC",
    credentialPresent: Boolean(cookie), runtime: Bun.version,
    sourceSha256: Object.fromEntries(await Promise.all([
      "src/application/SonGuessrService.ts", "src/infrastructure/NeteaseMusicProvider.ts",
    ].map(async path => [path, createHash("sha256").update(await Bun.file(path).text()).digest("hex")]))),
    assumptions: {
      live: cookie ? "真实登录权限；真实歌单与歌曲加载" : "公开歌单与真实匿名歌曲加载；单人公开题库流程，不验证账号会员过滤",
      replay: "真实歌单快照；登录与歌曲资源为夹具；生产选歌、默认随机源、回合命令均为原实现；回放仅对歌单前1000首进行候选集抽样",
      browserPlaybackVerified: false, realAccountVipPermissionVerified: Boolean(cookie), generalUnblockEnabled: false,
      minPopularity: 0, artistFilter: false,
    },
    playlists: [] as unknown[],
  };
  const output = resolve("../tasks/song-random/report.json");
  for (const id of ids) {
    const playlist = await real.getPlaylistSongs(id, cookie);
    const songById = new Map(playlist.songs.map(song => [song.id, song]));
    const summary = {
      playlistId: id, returned: playlist.songs.length, unique: songById.size,
      nonVipCandidates: playlist.songs.filter(song => !song.requiresVip).length,
      live: {requestedRounds: requestedLiveRounds, requestedAttempts: liveAttempts, attempts: 0, titleArtistMetrics: {}, audioProbe: null as unknown, ids: [] as string[], resources: [] as unknown[], failures: [] as unknown[], metrics: {}},
      replay: [] as unknown[],
    };
    let activeAttempt = 0;
    const liveProvider: MusicProvider = {
      search: (keyword, limit) => real.search(keyword, limit, cookie),
      getSongMetadata: songId => real.getSongMetadata(songId, cookie),
      getPlaylistSongs: (...args) => real.getPlaylistSongs(args[0], cookie),
      getLoginStatus: cookie ? () => real.getLoginStatus(cookie) : async supplied => ({
        cookie: supplied, account: {nickname: "隔离非会员夹具", vipStatus: "nonVip"},
      }),
      async getSong(songId) {
        const song = await real.getSong(songId, cookie);
        if (!summary.live.audioProbe) {
          try {
            const response = await fetch(song.audioUrl, {
              headers: {Range: "bytes=0-1023"}, signal: AbortSignal.timeout(10_000),
            });
            summary.live.audioProbe = {
              status: response.status,
              contentType: response.headers.get("content-type"),
              contentRange: response.headers.get("content-range"),
            };
            await response.body?.cancel();
          } catch { summary.live.audioProbe = {id: songId, error: "AUDIO_PROBE_FAILED"}; }
        }
        summary.live.resources.push({https: song.audioUrl.startsWith("https://"), lyricLines: song.lyrics.length, popularity: song.popularity});
        return song;
      },
    };
    if (liveAttempts) {
      const driver = await createProbeRoom(liveProvider, cookie ?? "MUSIC_U=isolated-fixture", playlist.info);
      try {
        for (let attempt = 1; attempt <= liveAttempts; attempt++) {
          if (summary.live.ids.length >= requestedLiveRounds) break;
          activeAttempt = attempt;
          summary.live.attempts = attempt;
          try { summary.live.ids.push(await driver.next()); }
          catch (error) {
            const code = driver.lastError ?? (error as {code?: string}).code ?? "UNKNOWN";
            summary.live.failures.push({attempt, code});
            if (code === "MUSIC_API_RATE_LIMITED") break;
          }
          console.log(JSON.stringify({id, attempt, success: summary.live.ids.length, failed: summary.live.failures.length}));
        }
      } finally { await driver.close(); }
    }
    summary.live.metrics = measureSequence(summary.live.ids);
    summary.live.titleArtistMetrics = measureSongNames(playlist.songs, summary.live.ids);
    for (const vipStatus of ["vip", "nonVip"] as const) {
      const replayProvider: MusicProvider = {
        search: async () => [], getSongMetadata: async songId => fixtureSong(songById.get(songId)!),
        getPlaylistSongs: async () => playlist,
        getSong: async songId => fixtureSong(songById.get(songId)!),
        getLoginStatus: async supplied => ({cookie: supplied, account: {nickname: "隔离回放夹具", vipStatus}}),
      };
      const sequences: string[][] = [];
      for (let room = 0; room < rooms; room++) {
        const driver = await createProbeRoom(replayProvider, "MUSIC_U=isolated-fixture", playlist.info);
        const sequence: string[] = [];
        try { for (let round = 0; round < replayRounds; round++) sequence.push(await driver.next()); }
        finally { await driver.close(); }
        sequences.push(sequence);
      }
      const pool = vipStatus === "vip" ? songById.size : summary.nonVipCandidates;
      summary.replay.push({
        vipStatus, pool, rooms,
        windows: [20, 30, 100].map(rounds => {
          const metrics = sequences.map(sequence => measureSequence(sequence.slice(0, rounds)));
          const nameMetrics = sequences.map(sequence => measureSongNames(playlist.songs, sequence.slice(0, rounds)));
          return {
            rounds,
            meanUnique: metrics.reduce((sum, metric) => sum + metric.unique, 0) / rooms,
            meanRepeatRate: metrics.reduce((sum, metric) => sum + metric.repeatRate, 0) / rooms,
            roomsWithRepeat: metrics.filter(metric => metric.repeats > 0).length,
            probabilityAnyRepeat: metrics.filter(metric => metric.repeats > 0).length / rooms,
            recentTenRepeats: metrics.reduce((sum, metric) => sum + metric.recentTenRepeats, 0),
            theoreticalUnique: expectedUnique(pool, rounds),
            meanTitleArtistRepeatRate: nameMetrics.reduce((sum, metric) => sum + metric.repeatRate, 0) / rooms,
            titleArtistRecentTenRepeats: nameMetrics.reduce((sum, metric) => sum + metric.recentTenRepeats, 0),
            titleArtistAdjacentRepeats: nameMetrics.reduce((sum, metric) => sum + metric.adjacentRepeats, 0),
          };
        }),
      });
    }
    report.playlists.push(summary);
    const safeReport = structuredClone(report) as typeof report;
    for (const item of safeReport.playlists as Array<Record<string, any>>) {
      delete item.live.ids;
      delete item.live.resources;
    }
    await Bun.write(output, JSON.stringify(safeReport, null, 2));
    console.log(JSON.stringify({id, live: summary.live.metrics, output}));
  }
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
