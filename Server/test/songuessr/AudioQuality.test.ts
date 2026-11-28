import { describe, expect, test } from "bun:test";
import {
  audioTicketOf,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  makeSong,
  provider,
  startRound,
  type TestConnection,
} from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import { AppError } from "../../src/domain/Errors";
import type { MusicCookieInput, MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import type {
  SonGuessrAudioQualityAck,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
  SongAudioQuality,
} from "../../src/shared/Index";

const SONG_ID = "netease:2468013579";
const DEFAULT_URL = "https://m801.music.example.net/default.mp3";

const qualityProvider = (
  variant: MusicProvider["getSongAudioVariant"],
  extra: Partial<MusicProvider> = {}
): MusicProvider => ({
  ...provider,
  getSong: async (id) => ({ ...makeSong(id, "答案歌", 2022), audioUrl: DEFAULT_URL }),
  getSongMetadata: async (id) => ({ ...makeSong(id, "答案歌", 2022), audioUrl: DEFAULT_URL }),
  getSongAudioVariant: variant,
  ...extra,
});

const setup = async (musicProvider: MusicProvider) => {
  const service = new SonGuessrService({ musicProvider, random: { nextInt: () => 0 } });
  const host = connection(service, "quality-host");
  const guest = connection(service, "quality-guest");
  await createRoom(service, host);
  const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
  await joinRoom(service, guest, "听众");
  await startRound(service, host, guest, hostState.playerId, SONG_ID);
  const ticket = audioTicketOf(lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot"));
  return { service, host, guest, ticket };
};

const requestQuality = (
  service: SonGuessrService,
  client: TestConnection,
  quality: SongAudioQuality,
  roundNumber = 1
) =>
  execute<SonGuessrAudioQualityAck>(service, client, {
    id: `quality-${client.record.id}-${quality}-${roundNumber}`,
    type: "song.game.audioQuality",
    roomId: "1234",
    payload: { roundNumber, quality },
  });

describe("猜歌自选音质", () => {
  test("取到的档位走同一张票据、带档位参数，跳转到那一档；默认地址不受影响", async () => {
    const calls: Array<{ songId: string; quality: SongAudioQuality }> = [];
    const { service, guest, ticket } = await setup(
      qualityProvider(async (songId, quality) => {
        calls.push({ songId, quality });
        return { url: "https://m801.music.example.net/lossless.flac", quality, format: "flac" };
      })
    );

    const ack = await requestQuality(service, guest, "lossless");
    expect(ack).toEqual({
      quality: "lossless",
      audioUrl: `/api/songuessr/audio/1234/${ticket}?q=lossless`,
      format: "flac",
    });
    expect(calls).toEqual([{ songId: SONG_ID, quality: "lossless" }]);
    expect(service.resolveAudioRedirect("1234", ticket, "lossless")).toBe(
      "https://m801.music.example.net/lossless.flac"
    );
    // 不带参数、没取过的档、乱写的参数都回到默认地址，不让播放失败。
    expect(service.resolveAudioRedirect("1234", ticket)).toBe(DEFAULT_URL);
    expect(service.resolveAudioRedirect("1234", ticket, "master")).toBe(DEFAULT_URL);
    expect(service.resolveAudioRedirect("1234", ticket, "../evil")).toBe(DEFAULT_URL);
    // 票据不符仍然一律拿不到，档位参数不能绕开票据。
    expect(service.resolveAudioRedirect("1234", "x".repeat(32), "lossless")).toBeUndefined();
  });

  test("上游降档时回执报实际档位，站内地址按实际档位跳转", async () => {
    const { service, guest, ticket } = await setup(
      qualityProvider(async () => ({
        url: "https://m801.music.example.net/exhigh.mp3",
        quality: "exhigh",
        format: "mp3",
      }))
    );
    const ack = await requestQuality(service, guest, "master");
    expect(ack).toMatchObject({ quality: "exhigh", format: "mp3" });
    expect(ack.audioUrl).toEndWith("?q=exhigh");
    expect(service.resolveAudioRedirect("1234", ticket, "exhigh")).toBe(
      "https://m801.music.example.net/exhigh.mp3"
    );
    expect(service.resolveAudioRedirect("1234", ticket, "master")).toBe(DEFAULT_URL);
  });

  test("同一回合同一档全房只打一次上游：并发合并、之后直接复用，复用不扣额度", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, host, guest } = await setup(
      qualityProvider(async (_songId, quality) => {
        calls += 1;
        await gate;
        return { url: "https://m801.music.example.net/hires.flac", quality };
      })
    );
    const first = requestQuality(service, guest, "hires");
    const second = requestQuality(service, host, "hires");
    release();
    await expect(first).resolves.toMatchObject({ quality: "hires" });
    await expect(second).resolves.toMatchObject({ quality: "hires" });
    for (let index = 0; index < 40; index += 1) {
      await expect(requestQuality(service, guest, "hires")).resolves.toMatchObject({
        quality: "hires",
      });
    }
    expect(calls).toBe(1);
  });

  test("这首歌没有该档时本回合记住，不再为它打上游；瞬态失败不记，下次重试", async () => {
    let unavailableCalls = 0;
    let flakyCalls = 0;
    const { service, guest } = await setup(
      qualityProvider(async (_songId, quality) => {
        if (quality === "dolby") {
          unavailableCalls += 1;
          throw new AppError("SONG_UNAVAILABLE", "这首歌没有可用的该档音质");
        }
        flakyCalls += 1;
        if (flakyCalls === 1) throw new AppError("MUSIC_API_TIMEOUT", "上游超时");
        return { url: "https://m801.music.example.net/lossless.flac", quality };
      })
    );
    await expect(requestQuality(service, guest, "dolby")).resolves.toEqual({ unavailable: true });
    await expect(requestQuality(service, guest, "dolby")).resolves.toEqual({ unavailable: true });
    expect(unavailableCalls).toBe(1);

    await expect(requestQuality(service, guest, "lossless")).rejects.toMatchObject({
      code: "MUSIC_API_TIMEOUT",
    });
    await expect(requestQuality(service, guest, "lossless")).resolves.toMatchObject({
      quality: "lossless",
    });
    expect(flakyCalls).toBe(2);
  });

  test("不是当前回合、或上游不支持选档时不报错，客户端照旧用默认地址", async () => {
    const { service, guest } = await setup(qualityProvider(undefined));
    await expect(requestQuality(service, guest, "lossless", 2)).resolves.toEqual({ ignored: true });
    await expect(requestQuality(service, guest, "lossless")).resolves.toEqual({
      unavailable: true,
    });
  });

  test("换回合后旧回合的档位全部作废，新回合重新向上游要", async () => {
    let calls = 0;
    const { service, host, guest } = await setup(
      qualityProvider(async (_songId, quality) => {
        calls += 1;
        return { url: `https://m801.music.example.net/${calls}.flac`, quality };
      })
    );
    await requestQuality(service, guest, "lossless");
    const oldTicket = audioTicketOf(lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot"));
    await execute(service, host, {
      id: "skip",
      type: "song.game.skipRound",
      roomId: "1234",
      payload: {},
    });
    // 结算阶段放的仍是这一回合的歌：照样能换档，而且复用猜题时取到的那一档。
    await expect(requestQuality(service, guest, "lossless")).resolves.toMatchObject({
      quality: "lossless",
    });
    expect(calls).toBe(1);
    expect(service.resolveAudioRedirect("1234", oldTicket, "lossless")).toBe(
      "https://m801.music.example.net/1.flac"
    );
  });

  test("取档优先用会员档更高的账号，免得被上游降档", async () => {
    const usedCookies: Array<MusicCookieInput | undefined> = [];
    const tiers: Record<string, "svip" | "vip" | undefined> = {
      "MUSIC_U=test-host": undefined,
      "MUSIC_U=guest-svip": "svip",
    };
    const service = new SonGuessrService({
      random: { nextInt: () => 0 },
      musicProvider: qualityProvider(
        async (_songId, quality, cookie) => {
          usedCookies.push(cookie);
          return { url: "https://m801.music.example.net/master.flac", quality };
        },
        {
          getLoginStatus: async (cookie) => ({
            cookie,
            account: {
              platform: "netease",
              nickname: tiers[cookie] ? "黑胶" : "普通",
              vipStatus: tiers[cookie] ? "vip" : "nonVip",
              vipTier: tiers[cookie],
            },
          }),
        }
      ),
    });
    const host = connection(service, "tier-host");
    const guest = connection(service, "tier-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "超级黑胶");
    // 房主的普通号先进池：只按加入时间取号会挑到它。
    await execute(service, guest, {
      id: "svip-loads",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=guest-svip" },
    });
    await startRound(service, host, guest, hostState.playerId, SONG_ID);
    await requestQuality(service, guest, "master");
    expect(usedCookies).toEqual(["MUSIC_U=guest-svip"]);
  });
});
