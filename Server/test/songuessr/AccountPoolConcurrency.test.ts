import { AppError } from "../../src/domain/Errors";
import { SonGuessrRoomSnapshot } from "../../src/shared/Index";
import { describe, expect, test } from "bun:test";
import { connection, createRoom, execute, joinRoom, lastEvent, provider, songs } from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import { type MusicCookieInput, type MusicProvider } from "../../src/infrastructure/music/MusicProvider";

describe("账号池单号并发", () => {
  const gatedProvider = (usedCookies: Array<MusicCookieInput | undefined>) => {
    const releases: Array<() => void> = [];
    const musicProvider: MusicProvider = {
      ...provider,
      search: async (_keyword, _limit, cookie) => {
        usedCookies.push(cookie);
        await new Promise<void>((resolve) => releases.push(resolve));
        return [songs.answer];
      },
    };
    return { musicProvider, releases };
  };

  const waitCalls = async (usedCookies: unknown[], count: number) => {
    for (let attempt = 0; attempt < 400 && usedCookies.length < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(usedCookies.length).toBe(count);
  };

  test("单号限额与改造前一致：3 个并发，第 4 个排队等空位", async () => {
    const usedCookies: Array<MusicCookieInput | undefined> = [];
    const { musicProvider, releases } = gatedProvider(usedCookies);
    const service = new SonGuessrService({ musicProvider });
    const host = connection(service, "single-account-host");
    await createRoom(service, host);

    const search = (id: string) =>
      execute(service, host, {
        id,
        type: "song.music.search",
        roomId: "1234",
        payload: { keyword: id },
      });
    const pending = [search("search-1")];
    await waitCalls(usedCookies, 1);
    // 单号上限取改造前 provider 的全局并发 3：前三个请求由这个号接单。
    for (let index = 2; index <= 4; index += 1) {
      pending.push(search(`search-${index}`));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(usedCookies).toHaveLength(3);

    // 第 4 个在排队而不是降级：归还一个租约后它拿到的还是这个号。
    releases.shift()!();
    await waitCalls(usedCookies, 4);
    expect(usedCookies).toEqual([
      { netease: "MUSIC_U=test-host" },
      { netease: "MUSIC_U=test-host" },
      { netease: "MUSIC_U=test-host" },
      { netease: "MUSIC_U=test-host" },
    ]);
    releases.splice(0).forEach((release) => release());
    await Promise.all(pending);
  });

  test("多号按单号限额倍乘：两个号最多 6 个在途，第 7 个排队", async () => {
    const usedCookies: Array<MusicCookieInput | undefined> = [];
    const { musicProvider, releases } = gatedProvider(usedCookies);
    const service = new SonGuessrService({ musicProvider });
    const host = connection(service, "two-account-host");
    const guest = connection(service, "two-account-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "贡献者");
    await execute(service, guest, {
      id: "guest-loads",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=guest-cookie" },
    });

    const search = (id: string) =>
      execute(service, host, {
        id,
        type: "song.music.search",
        roomId: "1234",
        payload: { keyword: id },
      });
    const pending = [search("multi-1")];
    await waitCalls(usedCookies, 1);
    for (let index = 2; index <= 7; index += 1) {
      pending.push(search(`multi-${index}`));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(usedCookies).toHaveLength(6);

    // 每个号各 3 个在途，总容量 = 3 × 2；第 7 个排队等空位，归还后继续用号而不是降级。
    releases.shift()!();
    await waitCalls(usedCookies, 7);
    expect(usedCookies).toHaveLength(7);
    expect(usedCookies.every(Boolean)).toBe(true);
    releases.splice(0).forEach((release) => release());
    await Promise.all(pending);
  });
});

describe("聚合租约按平台归还", () => {
  test("QQ 歌单取曲因 QQ 凭据失效失败时，不会把网易云账号判死", async () => {
    const musicProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie, platform) => ({
        cookie,
        account: { platform: platform === "qq" ? "qq" : "netease", nickname: "号主" },
      }),
      getPlaylistSongs: async (playlistId) => {
        if (playlistId.startsWith("qq:")) {
          throw new AppError("MUSIC_SESSION_INVALID", "QQ 音乐登录状态已失效");
        }
        return { info: { id: playlistId, name: "歌单", songCount: 1 }, songs: [songs.answer] };
      },
    };
    const service = new SonGuessrService({ musicProvider, random: { nextInt: () => 0 } });
    const host = connection(service, "lease-host");
    const guest = connection(service, "lease-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "QQ 号主");
    await execute(service, guest, {
      id: "lease-qq",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "qm_keyst=qq-cookie", platform: "qq" },
    });
    await execute(service, host, {
      id: "lease-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "qq:42", name: "QQ 歌单", songCount: 1 },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    await execute(service, guest, {
      id: "lease-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await expect(
      execute(service, host, {
        id: "lease-start",
        type: "song.game.start",
        roomId: "1234",
        payload: {},
      })
    ).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });

    await execute(service, host, {
      id: "lease-sync",
      type: "song.room.requestSync",
      roomId: "1234",
      payload: {},
    });
    const pool = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").musicPool ?? [];
    const netease = pool.find((entry) => entry.platform === "netease");
    const qq = pool.find((entry) => entry.platform === "qq");
    // 失败只属于 QQ：它的账号被判死关闭，网易云账号照常可用、没有冷却与失败记录。
    expect(qq).toMatchObject({ enabled: false });
    expect(netease).toMatchObject({ enabled: true });
    expect(netease?.cooldownUntil).toBeUndefined();
    expect(netease?.lastFailureReason).toBeUndefined();
  });
});

test("Agent 默认被拒绝，房主打开 allowAgents 后可进入并带身份标记", async () => {
  const service = new SonGuessrService({ musicProvider: provider });
  const host = connection(service, "agent-admission-host");
  await createRoom(service, host);
  const agent = connection(service, "agent-admission");
  agent.record.isAgent = true;

  await expect(
    execute(service, agent, {
      id: "agent-join-denied",
      type: "song.room.join",
      roomId: "1234",
      payload: { userName: "AgentOne" },
    })
  ).rejects.toMatchObject({ code: "AGENTS_NOT_ALLOWED" });

  await execute(service, host, {
    id: "allow-agents",
    type: "song.room.updateSettings",
    roomId: "1234",
    payload: { allowAgents: true },
  });
  const joined = await execute<{ playerId: string; snapshot: SonGuessrRoomSnapshot }>(
    service,
    agent,
    {
      id: "agent-join-allowed",
      type: "song.room.join",
      roomId: "1234",
      payload: { userName: "AgentOne" },
    }
  );
  expect(joined.snapshot.settings.allowAgents).toBe(true);
  expect(joined.snapshot.players.find((player) => player.id === joined.playerId)?.isAgent).toBe(
    true
  );
});
