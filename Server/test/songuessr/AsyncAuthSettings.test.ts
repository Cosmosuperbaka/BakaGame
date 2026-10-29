import { describe, expect, test } from "bun:test";
import {
  makeSong,
  songs,
  anime,
  wrongAnime,
  provider,
  connection,
  execute,
  lastEvent,
  createRoom,
  joinRoom,
  startRound,
  deferredServiceResult,
} from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  type BangumiSubjectDetails,
  type SongDetails,
  type SonGuessrPrivateState,
  type SonGuessrRoomSnapshot,
} from "../../src/shared/Index";
import { AppError } from "../../src/domain/Errors";
import {
  type MusicCookieInput,
  type MusicProvider,
} from "../../src/infrastructure/NeteaseMusicProvider";
import { AggregatedMusicProvider } from "../../src/infrastructure/AggregatedMusicProvider";
import { type BangumiDataProvider } from "../../src/infrastructure/LocalBangumiProvider";

describe("SonGuessr service 异步归属回归", () => {
  for (const fails of [false, true]) {
    test("自动下一轮迟到" + (fails ? "失败" : "成功") + "不得覆盖返回等待", async () => {
      const pending = deferredServiceResult<{
        info: { id: string; name: string; songCount: number };
        songs: SongDetails[];
      }>();
      let delay = false;
      const service = new SonGuessrService({
        musicProvider: {
          ...provider,
          getPlaylistSongs: async () =>
            delay
              ? pending.promise
              : { info: { id: "42", name: "fixture", songCount: 1 }, songs: [songs.answer] },
        },
      });
      const host = connection(service, "late-next-host");
      await createRoom(service, host, { solo: true });
      await execute(service, host, {
        id: "start",
        type: "song.game.start",
        roomId: "1234",
        payload: {},
      });
      await execute(service, host, {
        id: "skip",
        type: "song.game.skipRound",
        roomId: "1234",
        payload: {},
      });
      delay = true;
      const next = execute(service, host, {
        id: "next",
        type: "song.game.nextRound",
        roomId: "1234",
        payload: {},
      });
      const rejected = next.then(
        () => undefined,
        (error: unknown) => error
      );
      await execute(service, host, {
        id: "finish",
        type: "song.game.finish",
        roomId: "1234",
        payload: {},
      });
      if (fails) pending.reject(new AppError("MUSIC_API_FAILED", "fixture"));
      else
        pending.resolve({
          info: { id: "42", name: "fixture", songCount: 1 },
          songs: [songs.answer],
        });
      expect(await rejected).toBeInstanceOf(AppError);
      await execute(service, host, {
        id: "sync",
        type: "song.room.requestSync",
        roomId: "1234",
        payload: {},
      });
      expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("waiting");
    });
  }

  for (const kind of ["song", "anime"] as const) {
    test(kind + "校验中拒绝放弃且不接受跨命令竞态", async () => {
      const songPending = deferredServiceResult<SongDetails>();
      const animePending = deferredServiceResult<BangumiSubjectDetails>();
      let delay = false;
      const service = new SonGuessrService({
        musicProvider: { ...provider, getSongMetadata: async () => songPending.promise },
        bangumiProvider: {
          getSubject: async () => (delay ? animePending.promise : anime),
          searchSubjects: async () => [anime],
        } as unknown as BangumiDataProvider,
      });
      const host = connection(service, "flight-host");
      const guest = connection(service, "flight-guest");
      await createRoom(service, host);
      await joinRoom(service, guest, "猜题者");
      if (kind === "anime")
        await execute(service, host, {
          id: "settings",
          type: "song.room.updateSettings",
          roomId: "1234",
          payload: { questionType: "anime" },
        });
      await execute(service, guest, {
        id: "ready",
        type: "song.player.setReady",
        roomId: "1234",
        payload: { ready: true },
      });
      await execute(service, host, {
        id: "start",
        type: "song.game.start",
        roomId: "1234",
        payload: {},
      });
      await execute(service, host, {
        id: "choose",
        type: "song.game.chooseSubmitter",
        roomId: "1234",
        payload: { playerId: host.record.playerId! },
      });
      if (kind === "song")
        await execute(service, host, {
          id: "submit",
          type: "song.game.submitSong",
          roomId: "1234",
          payload: { songId: "answer" },
        });
      else
        await execute(service, host, {
          id: "submit",
          type: "song.game.submitAnime",
          roomId: "1234",
          payload: { subjectId: anime.id },
        });
      await execute(service, guest, {
        id: "audio",
        type: "song.game.audioReady",
        roomId: "1234",
        payload: { roundNumber: 1 },
      });
      delay = true;
      const guess =
        kind === "song"
          ? execute(service, guest, {
              id: "guess",
              type: "song.game.guess",
              roomId: "1234",
              payload: { songId: "answer" },
            })
          : execute(service, guest, {
              id: "guess",
              type: "song.game.guessAnime",
              roomId: "1234",
              payload: { subjectId: anime.id },
            });
      await expect(
        execute(service, guest, {
          id: "giveup",
          type: "song.game.giveUp",
          roomId: "1234",
          payload: {},
        })
      ).rejects.toMatchObject({ code: "GUESS_IN_PROGRESS" });
      if (kind === "song") songPending.resolve(songs.answer);
      else animePending.resolve(anime);
      await guess;
      const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
      expect(snapshot.players.find((player) => player.id === guest.record.playerId)?.score).toBe(
        12
      );
    });
  }
});

describe("SonGuessr service 音乐认证意图", () => {
  for (const kind of ["cookie", "qr"] as const) {
    for (const action of ["clear", "replace", "leave"] as const) {
      test(kind + "迟到认证不能覆盖" + action, async () => {
        const pending =
          deferredServiceResult<
            Awaited<ReturnType<NonNullable<MusicProvider["getLoginStatus"]>>>
          >();
        const qrPending =
          deferredServiceResult<Awaited<ReturnType<NonNullable<MusicProvider["checkQrLogin"]>>>>();
        let delay = false;
        let usedCookie: MusicCookieInput | undefined;
        const service = new SonGuessrService({
          musicProvider: {
            ...provider,
            getLoginStatus: async (cookie) =>
              delay && cookie === "old"
                ? pending.promise
                : { cookie, account: { nickname: cookie, vipStatus: "vip" } },
            checkQrLogin: async () => qrPending.promise,
            search: async (_query, _limit, cookie) => {
              usedCookie = cookie;
              return [];
            },
          },
        });
        const host = connection(service, "auth-host");
        await createRoom(service, host);
        delay = true;
        const old = (
          kind === "cookie"
            ? execute(service, host, {
                id: "old",
                type: "song.auth.useCookie",
                roomId: "1234",
                payload: { cookie: "old" },
              })
            : execute(service, host, {
                id: "old",
                type: "song.auth.qr.check",
                roomId: "1234",
                payload: { key: "fixture-key" },
              })
        ).then(
          () => undefined,
          (error: unknown) => error
        );
        if (action === "clear")
          await execute(service, host, {
            id: "clear",
            type: "song.auth.clear",
            roomId: "1234",
            payload: {},
          });
        if (action === "replace")
          await execute(service, host, {
            id: "new",
            type: "song.auth.useCookie",
            roomId: "1234",
            payload: { cookie: "new" },
          });
        if (action === "leave")
          await execute(service, host, {
            id: "leave",
            type: "song.room.leave",
            roomId: "1234",
            payload: {},
          });
        const session = { cookie: "old", account: { nickname: "old", vipStatus: "vip" } };
        if (kind === "cookie")
          pending.resolve({ ...session, account: { ...session.account, vipStatus: "vip" } });
        else
          qrPending.resolve({
            status: "authorized",
            session: { ...session, account: { ...session.account, vipStatus: "vip" } },
            message: "ok",
          });
        expect(await old).toMatchObject({ code: "MUSIC_SESSION_INVALID" });
        if (action !== "leave") {
          await execute(service, host, {
            id: "sync",
            type: "song.room.requestSync",
            roomId: "1234",
            payload: {},
          });
          const snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
          expect(snapshot.musicAccountReady).toBe(action === "replace");
          await execute(service, host, {
            id: "search",
            type: "song.music.search",
            roomId: "1234",
            payload: { keyword: "fixture" },
          });
          expect(usedCookie).toEqual(action === "replace" ? { netease: "new" } : undefined);
        } else expect(service.getRoomSummaries()).toEqual([]);
      });
    }
  }
  test("网易云与QQ音乐双平台账号并发认证不互斥且共存", async () => {
    let capturedSearchCookie: any;
    const service = new SonGuessrService({
      musicProvider: {
        ...provider,
        getLoginStatus: async (cookie, platform) => ({
          cookie,
          account: {
            platform: platform === "qq" ? "qq" : "netease",
            nickname: platform === "qq" ? "QQ用户" : "网易云用户",
            vipStatus: "vip",
          },
        }),
        search: async (_query, _limit, cookie) => {
          capturedSearchCookie = cookie;
          return [];
        },
      },
    });
    const host = connection(service, "dual-host");
    await createRoom(service, host);

    const [neteaseRes, qqRes] = await Promise.all([
      execute(service, host, {
        id: "auth-netease",
        type: "song.auth.useCookie",
        roomId: "1234",
        payload: { cookie: "netease-cookie", platform: "netease" },
      }),
      execute(service, host, {
        id: "auth-qq",
        type: "song.auth.useCookie",
        roomId: "1234",
        payload: { cookie: "qq-cookie", platform: "qq" },
      }),
    ]);

    expect(neteaseRes).toMatchObject({ account: { platform: "netease" } });
    expect(qqRes).toMatchObject({ account: { platform: "qq" } });

    await execute(service, host, {
      id: "sync",
      type: "song.room.requestSync",
      roomId: "1234",
      payload: {},
    });
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.musicAccountReady).toBe(true);
    expect(snapshot.qqMusicAccountReady).toBe(true);
    expect(snapshot.musicAccounts?.netease?.nickname).toBe("网易云用户");
    expect(snapshot.musicAccounts?.qq?.nickname).toBe("QQ用户");

    await execute(service, host, {
      id: "search",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "test" },
    });
    expect(capturedSearchCookie).toEqual({
      netease: "netease-cookie",
      qq: "qq-cookie",
    });

    await execute(service, host, {
      id: "clear-netease",
      type: "song.auth.clear",
      roomId: "1234",
      payload: { platform: "netease" },
    });
    const snapshotAfterClear = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshotAfterClear.musicAccountReady).toBe(false);
    expect(snapshotAfterClear.qqMusicAccountReady).toBe(true);
    expect(snapshotAfterClear.musicAccounts?.qq?.nickname).toBe("QQ用户");
  });

  test("配置双平台账号后单人自动模式开局正常，不触发 cookie?.trim 崩溃且凭据正确解构", async () => {
    let capturedNeteaseCookie: any;
    const testSong = makeSong("netease:1", "自动选曲测试", 2022);
    const neteaseMock: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie: string) => ({
        cookie,
        account: {
          platform: "netease" as const,
          nickname: "网易云用户",
          vipStatus: "vip" as const,
        },
      }),
      getPlaylistSongs: async (id: string, cookie?: string) => {
        capturedNeteaseCookie = cookie;
        expect(typeof cookie).toBe("string");
        return {
          info: { id, name: "默认自动歌单", songCount: 1 },
          songs: [{ id: "netease:1", title: "自动选曲测试", artist: "测试歌手" }],
        };
      },
      getSong: async (id: string, cookie?: string) => {
        expect(typeof cookie).toBe("string");
        return testSong;
      },
    };
    const qqMock: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie: string) => ({
        cookie,
        account: { platform: "qq" as const, nickname: "QQ用户", vipStatus: "vip" as const },
      }),
    };
    const aggregated = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
    });
    const service = new SonGuessrService({ musicProvider: aggregated });
    const solo = connection(service, "dual-solo");
    await createRoom(service, solo, {
      roomId: "9999",
      name: "双平台单人房",
      userName: "独狼",
      solo: true,
    });

    await Promise.all([
      execute(service, solo, {
        id: "auth-netease",
        type: "song.auth.useCookie",
        roomId: "9999",
        payload: { cookie: "MUSIC_U=netease-token", platform: "netease" },
      }),
      execute(service, solo, {
        id: "auth-qq",
        type: "song.auth.useCookie",
        roomId: "9999",
        payload: { cookie: "qm_keyst=qq-token", platform: "qq" },
      }),
    ]);

    await execute(service, solo, {
      id: "start",
      type: "song.game.start",
      roomId: "9999",
      payload: {},
    });

    expect(capturedNeteaseCookie).toBe("MUSIC_U=netease-token");
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
    expect(snapshot.phase).toBe("playing");
    expect(snapshot.currentRound?.audioUrl).toBe(testSong.audioUrl);
  });

  test("自动出题取候选时凭据被判死，账号池按失败归还：摘号并记失败原因", async () => {
    const service = new SonGuessrService({
      musicProvider: {
        ...provider,
        getLoginStatus: async (cookie: string) => ({
          cookie,
          account: { platform: "netease" as const, nickname: "号主", vipStatus: "vip" as const },
        }),
        getPlaylistSongs: async () => {
          throw new AppError("MUSIC_SESSION_INVALID", "登录状态已失效");
        },
      },
    });
    const solo = connection(service, "candidate-dead");
    await createRoom(service, solo, {
      roomId: "9998",
      name: "候选判死",
      userName: "独狼",
      solo: true,
    });
    await execute(service, solo, {
      id: "candidate-auth",
      type: "song.auth.useCookie",
      roomId: "9998",
      payload: { cookie: "MUSIC_U=dead-token", platform: "netease" },
    });

    await expect(
      execute(service, solo, {
        id: "candidate-start",
        type: "song.game.start",
        roomId: "9998",
        payload: {},
      })
    ).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });
    await execute(service, solo, {
      id: "candidate-sync",
      type: "song.room.requestSync",
      roomId: "9998",
      payload: {},
    });

    const entry = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot").musicPool?.find(
      (candidate) => candidate.platform === "netease"
    );
    expect(entry).toMatchObject({
      enabled: false,
      recentOk: 0,
      lastFailureReason: "登录状态已失效",
    });
  });

  test("QQ音乐凭据失效时 useCookie 抛出 MUSIC_SESSION_INVALID 且开局校验清除失效会话", async () => {
    let qqValid = true;
    const testSong = makeSong("netease:1", "选曲测试", 2022);
    const mockProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (_cookie, platform) => {
        if (platform === "qq" && !qqValid) {
          throw new AppError("MUSIC_SESSION_INVALID", "QQ 音乐登录状态已失效，请重新扫码登录");
        }
        return {
          cookie: "valid-cookie",
          account: {
            platform: platform || "netease",
            userId: "123",
            nickname: "用户",
            vipStatus: "vip",
          },
        };
      },
      getSong: async () => testSong,
    };

    const service = new SonGuessrService({ musicProvider: mockProvider });
    const host = connection(service, "qq-invalid-host");
    await createRoom(service, host, { roomId: "8888", name: "QQ测试房", solo: true });

    // 1. 成功装载初始会话
    await execute(service, host, {
      id: "auth-qq",
      type: "song.auth.useCookie",
      roomId: "8888",
      payload: { cookie: "initial-qq-cookie", platform: "qq" },
    });
    let snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.qqMusicAccountReady).toBe(true);

    // 2. QQ 凭据在腾讯端过期后，再次 useCookie 直接抛出 MUSIC_SESSION_INVALID
    qqValid = false;
    await expect(
      execute(service, host, {
        id: "auth-qq-expired",
        type: "song.auth.useCookie",
        roomId: "8888",
        payload: { cookie: "expired-qq-cookie", platform: "qq" },
      })
    ).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });

    // 3. 开局刷新校验捕获失效，自动清除房间内已失效的会话，并拦截开局
    await expect(
      execute(service, host, { id: "start", type: "song.game.start", roomId: "8888", payload: {} })
    ).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });

    snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.qqMusicAccountReady).toBe(false);
    expect(snapshot.musicAccounts?.qq).toBeUndefined();
  });
});

describe("SonGuessr service 设置原子更新", () => {
  for (const invalid of ["password", "playlist"] as const) {
    test(invalid + "校验失败整包保持原状态并仍能公开加入", async () => {
      const service = new SonGuessrService({ musicProvider: provider });
      const host = connection(service, "atomic-host");
      const guest = connection(service, "atomic-guest");
      await createRoom(service, host);
      const before = structuredClone(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot"));
      await expect(
        execute(service, host, {
          id: "settings",
          type: "song.room.updateSettings",
          roomId: "1234",
          payload: {
            name: "失败修改",
            allowSpectators: false,
            lyricsLineCount: 10,
            ...(invalid === "password"
              ? { visibility: "private" as const }
              : { autoFilters: { playlist: { id: "invalid" }, artists: [], minPopularity: 0 } }),
          },
        })
      ).rejects.toMatchObject({
        code: invalid === "password" ? "PASSWORD_REQUIRED" : "INVALID_PLAYLIST",
      });
      await execute(service, host, {
        id: "sync",
        type: "song.room.requestSync",
        roomId: "1234",
        payload: {},
      });
      expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot")).toEqual(before);
      await joinRoom(service, guest, "无密码加入");
      expect(guest.record.roomId).toBe("1234");
    });
  }
  test("合法私密切换、空密码保留及公开清除", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "private-host");
    await createRoom(service, host);
    for (const payload of [
      { visibility: "private" as const, password: "secret" },
      { password: " " },
    ]) {
      await execute(service, host, {
        id: "settings",
        type: "song.room.updateSettings",
        roomId: "1234",
        payload,
      });
    }
    await joinRoom(service, connection(service, "private-guest"), "私密玩家", "1234", "secret");
    await execute(service, host, {
      id: "public",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { visibility: "public" },
    });
    await joinRoom(service, connection(service, "public-guest"), "公开玩家");
    await expect(
      execute(service, host, {
        id: "private-again",
        type: "song.room.updateSettings",
        roomId: "1234",
        payload: { visibility: "private" },
      })
    ).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
  });
});

describe("SonGuessr service 猜番依赖错误分类", () => {
  for (const stage of ["search", "detail", "popularity"] as const) {
    test(stage + "全局限流透传原错误且不尝试下一番剧", async () => {
      const error = new AppError("MUSIC_API_RATE_LIMITED", "fixture", { retryAfterMs: 1234 });
      let subjects = 0;
      const service = new SonGuessrService({
        musicProvider: {
          ...provider,
          search: async () => {
            if (stage === "search") throw error;
            return [songs.answer];
          },
          getSong: async () => {
            if (stage === "detail") throw error;
            return songs.answer;
          },
          getSongPopularity: async () => {
            if (stage === "popularity") throw error;
            return 100_000;
          },
        },
        bangumiProvider: {
          searchSubjects: async () => [anime, wrongAnime],
          getSubject: async () => {
            subjects++;
            return anime;
          },
        } as unknown as BangumiDataProvider,
      });
      const host = connection(service, "classified-host");
      await createRoom(service, host, { solo: true });
      await execute(service, host, {
        id: "settings",
        type: "song.room.updateSettings",
        roomId: "1234",
        payload: {
          questionType: "anime",
          animeAutoFilters: {
            ranking: "all",
            subjectLimit: 50,
            songMinPopularity: stage === "popularity" ? 1_000 : 0,
          },
        },
      });
      await expect(
        execute(service, host, {
          id: "start",
          type: "song.game.start",
          roomId: "1234",
          payload: {},
        })
      ).rejects.toBe(error);
      expect(subjects).toBe(1);
    });
  }
});

test("SonGuessr 全体音频从未就绪仍在准备宽限后获得完整答题窗口并硬截止", async () => {
  let now = 0;
  const service = new SonGuessrService({ now: () => now, musicProvider: provider });
  const host = connection(service, "no-audio-host");
  const guest = connection(service, "no-audio-guest");
  await createRoom(service, host);
  await joinRoom(service, guest, "猜题者");
  await startRound(service, host, guest, host.record.playerId!);
  now = 14_999;
  await service.runHousekeeping();
  expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").canGuess).toBe(false);
  now = 15_000;
  await service.runHousekeeping();
  const ready = lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState");
  expect(ready.canGuess).toBe(true);
  expect(ready.remainingGuesses).toBe(3);
  expect(ready.guessDeadlineAt).toBe(75_000);
  // 持续聊天刷新房间活动，终止不能来自 idle 清理，也不能被聊天续期。
  // 硬截止覆盖 3 次猜测窗口（锚点 15_000 + 3 × (60 + 20) 秒）。
  now = 200_000;
  await execute(service, guest, {
    id: "chat",
    type: "song.chat.send",
    roomId: "1234",
    payload: { text: "保持房间活跃" },
  });
  await service.runHousekeeping();
  expect(lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").phase).toBe("playing");
  now = 256_000;
  await execute(service, guest, {
    id: "chat2",
    type: "song.chat.send",
    roomId: "1234",
    payload: { text: "仍然活跃" },
  });
  await service.runHousekeeping();
  expect(lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").phase).toBe("roundResult");
  expect(service.getRoomSummaries()).toHaveLength(1);
});

test("SonGuessr 被撤销的下一轮 finally 不解除新开局锁", async () => {
  const old =
    deferredServiceResult<Awaited<ReturnType<NonNullable<MusicProvider["getPlaylistSongs"]>>>>();
  const current =
    deferredServiceResult<Awaited<ReturnType<NonNullable<MusicProvider["getPlaylistSongs"]>>>>();
  let calls = 0;
  const playlist = { info: { id: "42", name: "fixture", songCount: 1 }, songs: [songs.answer] };
  const service = new SonGuessrService({
    musicProvider: {
      ...provider,
      getPlaylistSongs: async () => {
        calls++;
        return calls === 1 ? playlist : calls === 2 ? old.promise : current.promise;
      },
    },
  });
  const host = connection(service, "new-lock-host");
  await createRoom(service, host, { solo: true });
  await execute(service, host, {
    id: "start",
    type: "song.game.start",
    roomId: "1234",
    payload: {},
  });
  await execute(service, host, {
    id: "skip",
    type: "song.game.skipRound",
    roomId: "1234",
    payload: {},
  });
  const next = execute(service, host, {
    id: "next",
    type: "song.game.nextRound",
    roomId: "1234",
    payload: {},
  }).then(
    () => undefined,
    (error: unknown) => error
  );
  await execute(service, host, {
    id: "finish",
    type: "song.game.finish",
    roomId: "1234",
    payload: {},
  });
  const start = execute(service, host, {
    id: "restart",
    type: "song.game.start",
    roomId: "1234",
    payload: {},
  });
  old.resolve(playlist);
  expect(await next).toMatchObject({ code: "ROUND_EXPIRED" });
  await expect(
    execute(service, host, {
      id: "duplicate",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    })
  ).rejects.toMatchObject({ code: "INVALID_PHASE" });
  current.resolve(playlist);
  await start;
  expect(calls).toBe(3);
  expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
});

test("SonGuessr 下一轮房主转移再返回也不得恢复旧操作", async () => {
  const pending =
    deferredServiceResult<Awaited<ReturnType<NonNullable<MusicProvider["getPlaylistSongs"]>>>>();
  let delay = false;
  const playlist = { info: { id: "42", name: "fixture", songCount: 1 }, songs: [songs.answer] };
  const service = new SonGuessrService({
    musicProvider: {
      ...provider,
      getPlaylistSongs: async () => (delay ? pending.promise : playlist),
    },
  });
  const host = connection(service, "transfer-host");
  const guest = connection(service, "transfer-guest");
  await createRoom(service, host);
  await joinRoom(service, guest, "接任者");
  await execute(service, host, {
    id: "settings",
    type: "song.room.updateSettings",
    roomId: "1234",
    payload: { questionMode: "automatic" },
  });
  await execute(service, guest, {
    id: "ready",
    type: "song.player.setReady",
    roomId: "1234",
    payload: { ready: true },
  });
  await execute(service, host, {
    id: "start",
    type: "song.game.start",
    roomId: "1234",
    payload: {},
  });
  await execute(service, host, {
    id: "skip",
    type: "song.game.skipRound",
    roomId: "1234",
    payload: {},
  });
  delay = true;
  const old = execute(service, host, {
    id: "next",
    type: "song.game.nextRound",
    roomId: "1234",
    payload: {},
  }).then(
    () => undefined,
    (error: unknown) => error
  );
  await execute(service, host, {
    id: "transfer",
    type: "song.room.transferHost",
    roomId: "1234",
    payload: { playerId: guest.record.playerId! },
  });
  await execute(service, guest, {
    id: "transfer-back",
    type: "song.room.transferHost",
    roomId: "1234",
    payload: { playerId: host.record.playerId! },
  });
  pending.resolve(playlist);
  expect(await old).toMatchObject({ code: "ROUND_EXPIRED" });
  expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("roundResult");
});

test("局部自动筛选输入归一为完整快照，不要求客户端伪造默认字段", async () => {
  const service = new SonGuessrService({ musicProvider: provider });
  const host = connection(service, "partial-filters-host");
  await createRoom(service, host);
  await execute(service, host, {
    id: "partial-filters",
    type: "song.room.updateSettings",
    roomId: "1234",
    payload: { autoFilters: { playlist: { id: "12345" } } },
  });
  const snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
  expect(snapshot.settings.autoFilters).toEqual({
    playlist: { id: "12345", name: undefined, songCount: undefined },
    artists: [],
    minPopularity: 0,
  });
});
