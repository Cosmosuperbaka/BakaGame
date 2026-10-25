import { AppError } from "../../src/domain/Errors";
import {
  AUTO_ANIME_CANDIDATE_LIMIT,
  AUTO_SONG_CANDIDATE_LIMIT,
  SUBMIT_SONG_TIMEOUT_MS,
  resolveRecentSongWindow,
} from "../../src/application/songuessr/Records";
import { MusicProvider } from "../../src/infrastructure/NeteaseMusicProvider";
import { describe, expect, test } from "bun:test";
import {
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  makeSong,
  provider,
  songs,
  startRound,
} from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  SonGuessrClientMessage,
  SonGuessrRoomSnapshot,
  SongDetails,
  type SonGuessrPrivateState,
} from "../../src/shared/Index";
import { ROOM_IDLE_TIMEOUT_MS, TEST_MODE_MAX_PLAYERS } from "../../src/config/Constants";

describe("上线前 P0 修复回归", () => {
  test("P0-1 一条连接加入另一个房间时，旧房间的幽灵席位被清理并直接关房", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const hostA = connection(service, "switch-a");
    const hostB = connection(service, "switch-b");
    await createRoom(service, hostA, { roomId: "1234" });
    await createRoom(service, hostB, { roomId: "5678", name: "新房间", userName: "乙房主" });

    // A 从 1234 切到 5678：旧房间只剩它一个人，必须被正常回收
    await execute(service, hostA, {
      id: "switch-join",
      type: "song.room.join",
      roomId: "5678",
      payload: { userName: "房主" },
    });

    const summaries = service.getRoomSummaries().map((summary) => summary.roomId);
    expect(summaries).toContain("5678");
    expect(summaries).not.toContain("1234");
  });

  test("P0-1 同一条连接重连它原本所在的房间不会被自己踢掉", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "reconnect-seat");
    await createRoom(service, host, { roomId: "4321" });
    const seat = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");

    await expect(
      execute(service, host, {
        id: "self-reconnect",
        type: "song.room.reconnect",
        payload: { roomId: "4321", sessionToken: seat.sessionToken },
      })
    ).resolves.toMatchObject({ roomId: "4321" });
  });

  test("P0-1 被拒绝的建房、加入与重连不会销毁原席位", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const hostA = connection(service, "keep-seat-a");
    const hostB = connection(service, "keep-seat-b");
    const hostC = connection(service, "keep-seat-c");
    await createRoom(service, hostA, { roomId: "1234" });
    await createRoom(service, hostB, { roomId: "5678", name: "新房间", userName: "乙房主" });
    await createRoom(service, hostC, {
      roomId: "2468",
      name: "私房",
      visibility: "private",
      password: "secret",
      userName: "丙房主",
    });

    await expect(
      execute(service, hostA, {
        id: "conflict-create",
        type: "song.room.create",
        payload: {
          roomId: "5678",
          name: "撞号房间",
          visibility: "public",
          allowSpectators: true,
          userName: "甲",
        },
      })
    ).rejects.toMatchObject({ code: "ROOM_EXISTS" });

    await expect(
      execute(service, hostA, {
        id: "wrong-password",
        type: "song.room.join",
        roomId: "2468",
        payload: { userName: "甲", password: "wrong" },
      })
    ).rejects.toMatchObject({ code: "PASSWORD_INCORRECT" });

    await expect(
      execute(service, hostA, {
        id: "missing-room",
        type: "song.room.join",
        roomId: "9999",
        payload: { userName: "甲" },
      })
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });

    await expect(
      execute(service, hostA, {
        id: "bad-token",
        type: "song.room.reconnect",
        payload: { roomId: "5678", sessionToken: "invalid-token" },
      })
    ).rejects.toMatchObject({ code: "SESSION_INVALID" });

    // 原席位仍绑定在原房间：还能正常发命令，房间也仍在列表里。
    await expect(
      execute(service, hostA, { id: "probe", type: "song.room.requestSync", payload: {} })
    ).resolves.toEqual({ synced: true });
    expect(service.getRoomSummaries().map((summary) => summary.roomId)).toContain("1234");
  });

  test("P0-2a 测试房间加机器人到总人数上限后拒绝继续添加", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "bot-host");
    await createRoom(service, host, { roomId: "Oblivionis" });

    const first = (await execute(service, host, {
      id: "add-bots-1",
      type: "song.test.addBot",
      roomId: "Oblivionis",
      payload: { count: 64 },
    })) as { addedPlayerIds: string[] };
    expect(first.addedPlayerIds).toHaveLength(TEST_MODE_MAX_PLAYERS - 1);

    await expect(
      execute(service, host, {
        id: "add-bots-2",
        type: "song.test.addBot",
        roomId: "Oblivionis",
        payload: { count: 1 },
      })
    ).rejects.toMatchObject({ code: "ROOM_FULL" });
  });

  test("P0-2b 测试房间空闲超时后被回收，未超时则保留", async () => {
    let now = 1_000_000;
    const service = new SonGuessrService({ musicProvider: provider, now: () => now });
    const host = connection(service, "idle-test-host");
    await createRoom(service, host, { roomId: "Oblivionis" });

    now += ROOM_IDLE_TIMEOUT_MS / 2;
    await service.runHousekeeping();
    expect(service.getHealthSnapshot().roomCount).toBe(1);

    now += ROOM_IDLE_TIMEOUT_MS;
    await service.runHousekeeping();
    expect(service.getHealthSnapshot().roomCount).toBe(0);
  });

  test("P0-4 单条连接的音乐请求超过配额后被拒且不影响其他连接", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "limit-host");
    const guest = connection(service, "limit-guest");
    await createRoom(service, host, { roomId: "8888" });
    await joinRoom(service, guest, "限流玩家", "8888");

    for (let index = 0; index < 20; index += 1) {
      await execute(service, host, {
        id: `search-${index}`,
        type: "song.music.search",
        roomId: "8888",
        payload: { keyword: "测试" },
      });
    }

    await expect(
      execute(service, host, {
        id: "search-over",
        type: "song.music.search",
        roomId: "8888",
        payload: { keyword: "测试" },
      })
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });

    await expect(
      execute(service, guest, {
        id: "search-other",
        type: "song.music.search",
        roomId: "8888",
        payload: { keyword: "测试" },
      })
    ).resolves.toBeTruthy();
  });

  test("P0-4 旁观者不能发起音乐类请求", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "spectator-host");
    const spectator = connection(service, "spectator-guest");
    await createRoom(service, host, { roomId: "1212" });
    await joinRoom(service, spectator, "旁观者", "1212");

    await execute(service, spectator, {
      id: "to-spectator",
      type: "song.player.setSpectator",
      roomId: "1212",
      payload: { spectator: true },
    });

    await expect(
      execute(service, spectator, {
        id: "spectator-search",
        type: "song.music.search",
        roomId: "1212",
        payload: { keyword: "测试" },
      })
    ).rejects.toMatchObject({ code: "SPECTATOR_FORBIDDEN" });
  });

  test("旁观者被指定为出题人后可以搜歌出题，其它旁观者仍然被拦", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "spectator-submit-host");
    const guesser = connection(service, "spectator-submit-guesser");
    const submitter = connection(service, "spectator-submit-one");
    const bystander = connection(service, "spectator-submit-two");
    await createRoom(service, host, { roomId: "1313" });
    await joinRoom(service, guesser, "猜歌玩家", "1313");
    const submitterState = await joinRoom(service, submitter, "旁观出题人", "1313");
    await joinRoom(service, bystander, "旁观路人", "1313");

    await execute(service, guesser, {
      id: "guesser-ready",
      type: "song.player.setReady",
      roomId: "1313",
      payload: { ready: true },
    });
    for (const client of [submitter, bystander]) {
      await execute(service, client, {
        id: `to-spectator-${client.record.id}`,
        type: "song.player.setSpectator",
        roomId: "1313",
        payload: { spectator: true },
      });
    }

    await execute(service, host, {
      id: "start",
      type: "song.game.start",
      roomId: "1313",
      payload: {},
    });
    await execute(service, host, {
      id: "choose",
      type: "song.game.chooseSubmitter",
      roomId: "1313",
      payload: { playerId: submitterState.playerId },
    });

    // 出题人是全房唯一的推进者，旁观席位也要能搜索与取详情
    await expect(
      execute(service, submitter, {
        id: "submitter-search",
        type: "song.music.search",
        roomId: "1313",
        payload: { keyword: "答案" },
      })
    ).resolves.toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ id: "answer" })]),
    });
    await expect(
      execute(service, submitter, {
        id: "submitter-submit",
        type: "song.game.submitSong",
        roomId: "1313",
        payload: { songId: "answer" },
      })
    ).resolves.toBeTruthy();
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");

    await expect(
      execute(service, bystander, {
        id: "bystander-search",
        type: "song.music.search",
        roomId: "1313",
        payload: { keyword: "答案" },
      })
    ).rejects.toMatchObject({ code: "SPECTATOR_FORBIDDEN" });
  });

  test("出题人选题超时后退回选出题人并公告原因，提交尝试会顺延时限", async () => {
    let now = 10_000;
    let resolveSong!: (song: SongDetails) => void;
    const pendingSong = new Promise<SongDetails>((resolve) => {
      resolveSong = resolve;
    });
    const delayedProvider: MusicProvider = { ...provider, getSong: async () => pendingSong };
    const service = new SonGuessrService({ musicProvider: delayedProvider, now: () => now });
    const host = connection(service, "deadline-host");
    const guest = connection(service, "deadline-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "出题人");
    await execute(service, guest, {
      id: "deadline-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "deadline-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "deadline-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: guestState.playerId },
    });

    const snapshot = () => lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    const announced = () =>
      snapshot()
        .chat.filter((message) => message.system)
        .map((message) => message.text);
    expect(snapshot()).toMatchObject({ phase: "submittingSong" });

    // 按到提交为止的慢上游不会被巡检弃题：时限从每次提交尝试重新起算
    now += SUBMIT_SONG_TIMEOUT_MS - 1;
    await service.runHousekeeping();
    expect(snapshot().phase).toBe("submittingSong");

    const submitPromise = execute(service, guest, {
      id: "deadline-submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    now += SUBMIT_SONG_TIMEOUT_MS - 1;
    await service.runHousekeeping();
    expect(snapshot().phase).toBe("submittingSong");
    resolveSong(songs.answer);
    await expect(submitPromise).resolves.toMatchObject({ roundNumber: 1 });

    // 回合结束回到结算后再开一轮，出题人不动手才会超时
    await execute(service, host, {
      id: "deadline-give-up-host",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "deadline-next",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "deadline-choose-2",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    now += SUBMIT_SONG_TIMEOUT_MS;
    await service.runHousekeeping();

    const released = snapshot();
    expect(released.phase).toBe("choosingSubmitter");
    expect(released.pendingSubmitterPlayerId).toBeUndefined();
    expect(released.submitterPrompt).toContain("没有在时限内选好歌曲");
    expect(announced()).toEqual(
      expect.arrayContaining([expect.stringContaining("没有在时限内选好歌曲")])
    );
  });

  test("出题人断线或被移出时公告出题已中止，退回选出题人", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "abort-host");
    const first = connection(service, "abort-first");
    const second = connection(service, "abort-second");
    await createRoom(service, host);
    const firstState = await joinRoom(service, first, "首位出题人");
    const secondState = await joinRoom(service, second, "次位出题人");
    for (const client of [first, second]) {
      await execute(service, client, {
        id: `abort-ready-${client.record.id}`,
        type: "song.player.setReady",
        roomId: "1234",
        payload: { ready: true },
      });
    }
    await execute(service, host, {
      id: "abort-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });

    const snapshot = () => lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    const announced = () =>
      snapshot()
        .chat.filter((message) => message.system)
        .map((message) => message.text);

    await execute(service, host, {
      id: "abort-choose-first",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: firstState.playerId },
    });
    expect(snapshot().phase).toBe("submittingSong");
    await service.unregisterConnection(first.record.id);
    expect(snapshot()).toMatchObject({ phase: "choosingSubmitter" });
    expect(snapshot().submitterPrompt).toContain("首位出题人 断线，出题已中止");
    expect(announced()).toEqual(
      expect.arrayContaining([expect.stringContaining("首位出题人 断线，出题已中止")])
    );

    await execute(service, host, {
      id: "abort-choose-second",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: secondState.playerId },
    });
    expect(snapshot().phase).toBe("submittingSong");
    expect(snapshot().submitterPrompt).toBeUndefined();
    await execute(service, host, {
      id: "abort-kick",
      type: "song.room.kick",
      roomId: "1234",
      payload: { playerId: secondState.playerId },
    });
    expect(snapshot()).toMatchObject({ phase: "choosingSubmitter" });
    expect(snapshot().submitterPrompt).toContain("次位出题人 已被移出");
    expect(announced()).toEqual(
      expect.arrayContaining([expect.stringContaining("次位出题人 已被移出，请重新指定出题人")])
    );
  });

  test("P0-5 大歌单候选全部取不到音频时自动出题的回源次数不超过常量上界", async () => {
    let attempts = 0;
    const pool = Array.from({ length: 30 }, (_, index) => ({
      ...songs.answer,
      id: `pool-${index}`,
      title: `候选${index}`,
    }));
    const brokenProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { nickname: "测试账号", vipStatus: "nonVip" },
      }),
      getPlaylistSongs: async (playlistId) => ({
        info: { id: playlistId, name: "大歌单", songCount: pool.length },
        songs: pool,
      }),
      // 会员曲解灰全部失败时 provider 直接抛「没有可用播放地址」，
      // 不再把试听片段或空地址交给上层；上层只把它当成「这个候选不能用」。
      getSong: async () => {
        attempts += 1;
        throw new AppError("SONG_UNAVAILABLE", "该歌曲暂时没有可用播放地址");
      },
    };

    const now = 2_000_000;
    const service = new SonGuessrService({
      musicProvider: brokenProvider,
      now: () => now,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "limit-host-2");
    const guest = connection(service, "limit-guest-2");
    await createRoom(service, host, { roomId: "2222" });
    await joinRoom(service, guest, "回源玩家", "2222");
    await execute(service, host, {
      id: "auto-settings",
      type: "song.room.updateSettings",
      roomId: "2222",
      payload: { questionMode: "automatic", autoFilters: { artists: [], minPopularity: 0 } },
    });
    await execute(service, guest, {
      id: "auto-ready",
      type: "song.player.setReady",
      roomId: "2222",
      payload: { ready: true },
    });

    await expect(
      execute(service, host, {
        id: "auto-start",
        type: "song.game.start",
        roomId: "2222",
        payload: {},
      })
    ).rejects.toMatchObject({ code: "SONG_UNAVAILABLE" });

    // 抽到不可用候选只换下一个，回源次数严格受常量上界约束。
    expect(attempts).toBe(AUTO_SONG_CANDIDATE_LIMIT);
  });

  test("P0-6 巡检不会抢占仍在上游校验中的猜测", async () => {
    let now = 3_000_000;
    let releaseMetadata: ((song: SongDetails) => void) | undefined;
    const slowProvider: MusicProvider = {
      ...provider,
      getSongMetadata: () =>
        new Promise<SongDetails>((resolve) => {
          releaseMetadata = resolve;
        }),
    };
    const service = new SonGuessrService({ musicProvider: slowProvider, now: () => now });
    const host = connection(service, "inflight-host");
    const guest = connection(service, "inflight-guest");
    await createRoom(service, host, { roomId: "3333" });
    const hostSeat = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "慢上游玩家", "3333");
    await startRound(service, host, guest, hostSeat.playerId);
    await execute(service, guest, {
      id: "inflight-audio",
      type: "song.game.audioReady",
      roomId: "3333",
      payload: { roundNumber: 1 },
    });

    const guessing = execute(service, guest, {
      id: "inflight-guess",
      type: "song.game.guess",
      roomId: "3333",
      payload: { songId: "wrong" },
    });

    // 猜测还卡在上游，此时巡检到达判定时间也不能替它记一次 timeout
    now += 60_000;
    await service.runHousekeeping();

    releaseMetadata!(songs.wrong);
    await guessing;

    const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    const privateState = lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState");
    // 只被扣了一次配额（默认上限 3，剩 2），且回合没有被巡检提前结算
    expect(privateState.remainingGuesses).toBe(2);
    expect(snapshot.phase).toBe("playing");
  });

  test("P0-7 未注册的命令不再静默 ACK", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "unknown-host");
    await createRoom(service, host, { roomId: "4444" });

    await expect(
      execute(service, host, {
        id: "unknown",
        type: "song.unknown.command" as unknown as SonGuessrClientMessage["type"],
        roomId: "4444",
        payload: {},
      } as unknown as SonGuessrClientMessage)
    ).rejects.toMatchObject({ code: "UNSUPPORTED_COMMAND" });
  });

  test("H-3 房主跳过回合不结算出题人奖励", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "skip-host");
    const guest = connection(service, "skip-guest");
    await createRoom(service, host, { roomId: "5555" });
    const hostSeat = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "跳过玩家", "5555");
    await startRound(service, host, guest, hostSeat.playerId);

    const result = await execute(service, host, {
      id: "skip",
      type: "song.game.skipRound",
      roomId: "5555",
      payload: {},
    });
    expect(result).toMatchObject({ skipped: true });

    // 跳过不是「无人猜中」，出题人拿不到任何奖励（否则反复跳就能零成本刷分）
    const summary = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").roundSummary;
    expect(summary?.scores.find((score) => score.playerId === hostSeat.playerId)?.score).toBe(0);
  });

  test("audioFailed 会刷新当前回合的播放地址", async () => {
    const service = new SonGuessrService({
      musicProvider: {
        ...provider,
        refreshSongAudio: async () => "https://audio/refreshed.mp3",
      },
    });
    const host = connection(service, "audio-host");
    const guest = connection(service, "audio-guest");
    await createRoom(service, host, { roomId: "6666" });
    const hostSeat = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "刷新玩家", "6666");
    await startRound(service, host, guest, hostSeat.playerId);

    await expect(
      execute(service, guest, {
        id: "audio-failed",
        type: "song.game.audioFailed",
        roomId: "6666",
        payload: { roundNumber: 1 },
      })
    ).resolves.toMatchObject({ refreshed: true });

    expect(
      lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").currentRound?.audioUrl
    ).toBe("https://audio/refreshed.mp3");
  });

  test("歌单解析支持链接与数字 ID", async () => {
    const service = new SonGuessrService({
      musicProvider: {
        ...provider,
        getPlaylistSongs: async (playlistId) => ({
          info: { id: playlistId, name: "测试歌单", songCount: 2 },
          songs: [songs.answer, songs.wrong],
        }),
      },
    });
    const host = connection(service, "playlist-host");
    await createRoom(service, host, { roomId: "7778" });

    await expect(
      execute(service, host, {
        id: "playlist-resolve",
        type: "song.music.playlist.resolve",
        roomId: "7778",
        payload: { value: "https://music.163.com/#/playlist?id=123456" },
      })
    ).resolves.toMatchObject({ playlist: { id: "123456", name: "测试歌单" } });
  });

  test("歌手搜索返回 provider 的结果", async () => {
    const service = new SonGuessrService({
      musicProvider: {
        ...provider,
        searchArtists: async () => [{ id: "artist-1", name: "测试歌手" }],
      },
    });
    const host = connection(service, "artist-host");
    await createRoom(service, host, { roomId: "7779" });

    await expect(
      execute(service, host, {
        id: "artist-search",
        type: "song.music.artist.search",
        roomId: "7779",
        payload: { keyword: "测试" },
      })
    ).resolves.toMatchObject({ results: [{ id: "artist-1", name: "测试歌手" }] });
  });

  test("两个候选回源常量都存在且取正值", () => {
    expect(AUTO_ANIME_CANDIDATE_LIMIT).toBeGreaterThan(0);
    expect(AUTO_SONG_CANDIDATE_LIMIT).toBeGreaterThan(0);
  });

  test("音频准备超时仅强制置为就绪并启动答题计时，绝不当作答题超时盗扣猜测配额", async () => {
    let mockTime = 100_000;
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => mockTime,
    });
    const host = connection(service, "host-audiowait");
    const guest = connection(service, "guest-audiowait");
    // 第三名玩家用于锚定本回合的计时窗口，guest 则始终不上报音频就绪。
    const idle = connection(service, "idle-audiowait");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "等待音频玩家");
    // 必须在回合安装前入座并准备，否则它既拿不到本回合的玩家状态，也会卡住开局检查。
    await joinRoom(service, idle, "已就绪玩家");
    await execute(service, idle, {
      id: "idle-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await startRound(service, host, guest, hostState.playerId);

    const initialSnapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(initialSnapshot.phase).toBe("playing");

    const guestInitialPrivate = lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState");
    expect(guestInitialPrivate.canGuess).toBe(false);
    expect(guestInitialPrivate.canGiveUp).toBe(true);
    expect(guestInitialPrivate.remainingGuesses).toBe(3);

    // 宽限期同样锚定在「首名玩家真正具备答题条件」的时刻：无人就绪就不该开始倒计时。
    await execute(service, idle, {
      id: "idle-audiowait-ready",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });

    // 时间前移 16 秒（超过 15 秒的 audioReadyDeadlineAt）
    mockTime += 16_000;
    await service.runHousekeeping();

    // 巡检后音频就绪宽限期结束：强制置为可答题状态并启动倒计时，但绝不扣除猜测机会
    const guestUpdatedPrivate = lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState");
    expect(guestUpdatedPrivate.canGuess).toBe(true);
    expect(guestUpdatedPrivate.remainingGuesses).toBe(3);
    expect(guestUpdatedPrivate.visibleAttempts).toHaveLength(0);
    // 补偿出来的倒计时必须从「补偿那一刻」起算（mockTime = 锚点 + 16s），
    // 绝不能沿用已经耗尽的宽限期锚点 —— 那会立刻得到一个已过期的截止时刻，
    // 下一轮巡检就把补偿出来的答题时间又当成超时收走。
    // 此处 60s < 硬截止剩余（锚点 + 80s），故不受硬截止封顶。
    expect(guestUpdatedPrivate.guessDeadlineAt).toBe(mockTime + 60_000);

    const currentSnapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(currentSnapshot.phase).toBe("playing");
    const guestPlayerView = currentSnapshot.players.find((p) => p.name === "等待音频玩家");
    expect(guestPlayerView?.roundStatus).toBe("guessing");
    expect(guestPlayerView?.guessesUsed).toBe(0);
  });

  test("迟到就绪的玩家从就绪那一刻起算完整倒计时，回合不会在倒计时尚余数十秒时被强制结算", async () => {
    let mockTime = 100_000;
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => mockTime,
    });
    const host = connection(service, "host-late-ready");
    const guest = connection(service, "guest-late-ready");
    const anchor = connection(service, "anchor-late-ready");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "迟到玩家");
    await joinRoom(service, anchor, "先就绪玩家");
    await execute(service, anchor, {
      id: "anchor-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    // 每次猜测只有一次机会、且单次答题时长放宽到 120s：
    // 放大倒计时窗口，好让「锚点是否前移」这个差异清晰可辨（硬截止 = 锚点 + 140s）。
    await execute(service, host, {
      id: "late-ready-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { maxGuessesPerRound: 1, guessDurationSeconds: 120 },
    });
    await startRound(service, host, guest, hostState.playerId);

    // 回合安装后 30s，首个玩家才真正就绪 —— 计时窗口必须从这一刻锚定，
    // 而不是从 installRound 那一刻（100_000）起算。硬截止 = 130_000 + 140s = 270_000。
    mockTime += 30_000;
    await execute(service, anchor, {
      id: "anchor-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });

    // 锚定玩家随即离场：本回合只剩「迟到玩家」一个有效猜题人，结算条件不再被它拖住。
    await service.unregisterConnection(anchor.record.id);

    // 自动选曲 / 音频加载再耗时 40s 后才真正就绪
    mockTime += 40_000;
    await execute(service, guest, {
      id: "guest-late-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    const latePrivate = lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState");
    expect(latePrivate.canGuess).toBe(true);
    // 倒计时必须从「当前时刻」起算（170_000 + 120s = 290_000），并被硬截止 270_000 封顶。
    // 旧实现沿用回合计时窗口锚点（130_000 + 120s = 250_000），玩家会凭空少掉 20 秒可答时间。
    expect(latePrivate.guessDeadlineAt).toBe(270_000);

    // 界面上倒计时还剩 30 秒（240_000）时推进一轮巡检：回合绝不能被结算。
    // 这正是线上观测到的「第二次时间还剩三十秒就直接结算了」。
    mockTime = 240_000;
    await service.runHousekeeping();
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").remainingGuesses).toBe(
      1
    );

    // 可见倒计时归零后，超时才如实生效
    mockTime = 271_000;
    await service.runHousekeeping();
    const settled = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(settled.phase).toBe("roundResult");
    expect(settled.roundSummary?.attempts[0]).toMatchObject({ result: "timeout" });
  });

  test("一次超时之后，后续每次猜测仍获得完整倒计时且不会被硬截止提前判超时", async () => {
    let mockTime = 100_000;
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => mockTime,
    });
    const host = connection(service, "host-timeout-window");
    const guest = connection(service, "guest-timeout-window");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "连续作答玩家");
    // 默认 3 次猜测、每次 60 秒；硬截止必须覆盖三次窗口，而不是只算一次。
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "timeout-window-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").guessDeadlineAt).toBe(
      mockTime + 60_000
    );

    // 第一次作答超时：扣一次并重开一整段 60 秒，而不是只剩「硬截止 - 当前时刻」的零头。
    mockTime += 60_001;
    await service.runHousekeeping();
    const afterTimeout = lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState");
    expect(afterTimeout.remainingGuesses).toBe(2);
    expect(afterTimeout.guessDeadlineAt).toBe(mockTime + 60_000);

    // 走到旧硬截止（锚点 + 80 秒）之后，第二次猜测仍应正常校验，
    // 不能报「本次猜测已经超时」——这正是线上反馈的复现点。
    mockTime += 20_000;
    await expect(
      execute(service, guest, {
        id: "timeout-window-guess",
        type: "song.game.guess",
        roomId: "1234",
        payload: { songId: "wrong" },
      })
    ).resolves.toMatchObject({ attempt: { result: "wrong" } });
    const afterWrong = lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState");
    expect(afterWrong.remainingGuesses).toBe(1);
    expect(afterWrong.guessDeadlineAt).toBe(mockTime + 60_000);
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");

    // 第三次窗口同样完整；次数耗尽后才结算。
    mockTime += 60_001;
    await service.runHousekeeping();
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("roundResult");
  });

  test("窗口到期到巡检落账之间的提交按下一段窗口继续，不会直接判超时", async () => {
    let mockTime = 100_000;
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => mockTime,
    });
    const host = connection(service, "host-late-submit");
    const guest = connection(service, "guest-late-submit");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "慢搜玩家");
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "late-submit-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });

    // 搜歌耗时越过了第一段窗口，但巡检（10 秒一轮）还没落账。
    mockTime += 61_000;
    const submitted = await execute<{
      attempt: { result: string; guessNumber: number };
      remainingGuesses: number;
    }>(service, guest, {
      id: "late-submit-guess",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "wrong" },
    });

    // 旧窗口先按超时落账，本次提交进入下一段窗口，而不是被旧截止时刻拒绝。
    expect(submitted.attempt).toMatchObject({ result: "wrong", guessNumber: 2 });
    expect(submitted.remainingGuesses).toBe(1);
    expect(
      lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").visibleAttempts.map(
        (attempt) => attempt.result
      )
    ).toEqual(["timeout", "wrong"]);
    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState")).toMatchObject({
      remainingGuesses: 1,
      guessDeadlineAt: mockTime + 60_000,
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
  });

  test("超时后连续提交按真实猜测结算，不会被逐次判超时耗尽次数", async () => {
    let mockTime = 100_000;
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => mockTime,
    });
    const host = connection(service, "host-repeat-submit");
    const guest = connection(service, "guest-repeat-submit");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "连续提交玩家");
    await execute(service, host, {
      id: "repeat-submit-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { maxGuessesPerRound: 4, guessDurationSeconds: 60 },
    });
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "repeat-submit-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });

    // 第一段窗口过期后再连续提交两次：第一次补记超时并进入新窗口，
    // 第二次必须在同一段新窗口里作为真实猜测校验，而不是又记一次超时。
    mockTime += 61_000;
    await expect(
      execute(service, guest, {
        id: "repeat-submit-first",
        type: "song.game.guess",
        roomId: "1234",
        payload: { songId: "wrong" },
      })
    ).resolves.toMatchObject({ attempt: { result: "wrong" }, remainingGuesses: 2 });
    await expect(
      execute(service, guest, {
        id: "repeat-submit-second",
        type: "song.game.guess",
        roomId: "1234",
        payload: { songId: "wrong" },
      })
    ).resolves.toMatchObject({ attempt: { result: "wrong" }, remainingGuesses: 1 });

    const privateState = lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState");
    expect(privateState.visibleAttempts.map((attempt) => attempt.result)).toEqual([
      "timeout",
      "wrong",
      "wrong",
    ]);
    expect(privateState.remainingGuesses).toBe(1);
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
  });

  test("回合硬截止过后再提交只强制结算一次，不会被连续点击逐次判超时", async () => {
    let mockTime = 100_000;
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => mockTime,
    });
    const host = connection(service, "host-hard-submit");
    const guest = connection(service, "guest-hard-submit");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "硬截止玩家");
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "hard-submit-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });

    // 越过锚点 + 3 × (60 + 20) 秒的硬截止，且巡检尚未落账。
    mockTime += 3 * (60 + 20) * 1_000 + 1_000;
    await expect(
      execute(service, guest, {
        id: "hard-submit-first",
        type: "song.game.guess",
        roomId: "1234",
        payload: { songId: "wrong" },
      })
    ).rejects.toMatchObject({ code: "ROUND_EXPIRED" });
    // 第一次提交已经把回合结算掉；再点只会得到「当前没有进行中的回合」，不会继续扣次数。
    await expect(
      execute(service, guest, {
        id: "hard-submit-second",
        type: "song.game.guess",
        roomId: "1234",
        payload: { songId: "wrong" },
      })
    ).rejects.toMatchObject({ code: "NO_ACTIVE_ROUND" });

    const settled = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(settled.phase).toBe("roundResult");
    expect(settled.roundSummary?.attempts.map((attempt) => attempt.result)).toEqual(["timeout"]);
  });

  test("活跃玩家切轮断线重连后通过 ensureRoundPlayerState 自动恢复回合状态且可正常答题", async () => {
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "host-reconnect-test");
    const guest = connection(service, "guest-reconnect-test");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "重连玩家");
    const guestToken = lastEvent<SonGuessrPrivateState>(
      guest,
      "song.game.privateState"
    ).sessionToken;

    // 玩家先设为准备
    await execute(service, guest, {
      id: "guest-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    // 第三名玩家保底在线数：installRound 要求下一轮至少两名在线正式玩家，
    // 否则两人房在 guest 掉线后开局会被 NOT_ENOUGH_PLAYERS 拒绝。
    const third = connection(service, "third-reconnect-test");
    await joinRoom(service, third, "陪玩玩家");
    await execute(service, third, {
      id: "third-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    // 模拟重连玩家临时掉线
    await service.unregisterConnection(guest.record.id);

    // 房主开局（回合安装时该玩家离线）
    await execute(service, host, {
      id: "ready-1",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "start-game",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose-self",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "submit-song",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });

    const playingSnapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(playingSnapshot.phase).toBe("playing");

    // 玩家重新连入房间
    const guestReconnected = connection(service, "guest-reconnected");
    const reconnectResult = (await execute(service, guestReconnected, {
      id: "guest-reconnect",
      type: "song.room.reconnect",
      payload: { roomId: "1234", sessionToken: guestToken },
    })) as any;

    expect(reconnectResult.privateState).toBeDefined();
    expect(reconnectResult.privateState.remainingGuesses).toBe(3);
    expect(reconnectResult.privateState.canGiveUp).toBe(true);

    // 上报音频就绪后即可正常答题
    await execute(service, guestReconnected, {
      id: "audio-ready",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    const readyPrivateState = lastEvent<SonGuessrPrivateState>(
      guestReconnected,
      "song.game.privateState"
    );
    expect(readyPrivateState.canGuess).toBe(true);

    // 提交猜测成功
    const guessResult = (await execute(service, guestReconnected, {
      id: "guess-song",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    })) as any;
    expect(guessResult.attempt.result).toBe("correct");
  });

  test("近期去重窗口按候选池自适应并在上下界截断", () => {
    // 池子装不满下限窗口时保持改动前的固定 10 首行为
    expect(resolveRecentSongWindow(0)).toBe(10);
    expect(resolveRecentSongWindow(15)).toBe(10);
    expect(resolveRecentSongWindow(20)).toBe(10);
    expect(resolveRecentSongWindow(21)).toBe(10);
    // 超过下限后按池子一半线性放长
    expect(resolveRecentSongWindow(40)).toBe(20);
    expect(resolveRecentSongWindow(56)).toBe(28);
    expect(resolveRecentSongWindow(347)).toBe(173);
    // 上界截断，避免超大歌单把房间的最近列表撑成任意长度
    expect(resolveRecentSongWindow(990)).toBe(495);
    expect(resolveRecentSongWindow(1000)).toBe(500);
    expect(resolveRecentSongWindow(1201)).toBe(500);
    expect(resolveRecentSongWindow(Number.NaN)).toBe(10);
  });

  test("大候选池放长去重窗口后，60 轮内不重现旧歌", async () => {
    // 400 首池子对应窗口 200，远大于本用例的 60 轮：出现任何重现都说明窗口没有生效。
    const poolSize = 400;
    const bigPool = Array.from({ length: poolSize }, (_, index) => ({
      id: `pool-${index}`,
      title: `池内曲目${index}`,
      artist: "测试歌手",
    }));
    const bigProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "大池", songCount: poolSize },
        songs: bigPool,
      }),
      getSong: async (songId) => makeSong(songId, `池内曲目${songId}`, 2020),
    };
    const service = new SonGuessrService({ musicProvider: bigProvider });
    const solo = connection(service, "window-solo");
    await createRoom(service, solo, {
      roomId: "7799",
      name: "去重窗口",
      allowSpectators: false,
      userName: "独狼",
      solo: true,
    });
    await execute(service, solo, {
      id: "window-settings",
      type: "song.room.updateSettings",
      roomId: "7799",
      payload: {
        autoFilters: {
          playlist: { id: "42", name: "大池", songCount: poolSize },
          artists: [],
          minPopularity: 0,
        },
      },
    });

    const chosen: string[] = [];
    for (let round = 1; round <= 60; round += 1) {
      await execute(service, solo, {
        id: `window-round-${round}`,
        type: round === 1 ? "song.game.start" : "song.game.nextRound",
        roomId: "7799",
        payload: {},
      });
      // 单人房给出放弃即可完成本回合，答案随 roundSummary 公开。
      await execute(service, solo, {
        id: `window-giveup-${round}`,
        type: "song.game.giveUp",
        roomId: "7799",
        payload: {},
      });
      const settled = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
      expect(settled.phase).toBe("roundResult");
      chosen.push(settled.roundSummary!.song.id);
    }

    expect(chosen).toHaveLength(60);
    expect(new Set(chosen).size).toBe(60);
  });

  test("自动出题遇到取不到音频的候选会继续抽下一个", async () => {
    const pool = [
      { id: "broken-1", title: "坏候选一", artist: "测试歌手" },
      { id: "broken-2", title: "坏候选二", artist: "测试歌手" },
      { id: "healthy", title: "好候选", artist: "测试歌手" },
    ];
    const fetched: string[] = [];
    const mixedProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async (playlistId) => ({
        info: { id: playlistId, name: "混合池", songCount: pool.length },
        songs: pool,
      }),
      getSong: async (songId) => {
        fetched.push(songId);
        if (songId !== "healthy") {
          throw new AppError("SONG_UNAVAILABLE", "该歌曲暂时没有可用播放地址");
        }
        return makeSong("healthy", "好候选", 2020);
      },
    };
    // nextInt 恒为 0：每轮都摘掉池子里的第一个，候选顺序完全确定。
    const service = new SonGuessrService({
      musicProvider: mixedProvider,
      random: { nextInt: () => 0 },
    });
    const solo = connection(service, "mixed-pool-solo");
    await createRoom(service, solo, {
      roomId: "7810",
      name: "混合池",
      allowSpectators: false,
      userName: "独狼",
      solo: true,
    });
    await execute(service, solo, {
      id: "mixed-settings",
      type: "song.room.updateSettings",
      roomId: "7810",
      payload: {
        autoFilters: {
          playlist: { id: "42", name: "混合池", songCount: pool.length },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    await execute(service, solo, {
      id: "mixed-start",
      type: "song.game.start",
      roomId: "7810",
      payload: {},
    });

    expect(fetched).toEqual(["broken-1", "broken-2", "healthy"]);
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
    expect(snapshot.phase).toBe("playing");
    expect(snapshot.currentRound?.audioUrl).toBe(makeSong("healthy", "好候选", 2020).audioUrl);
  });
});
