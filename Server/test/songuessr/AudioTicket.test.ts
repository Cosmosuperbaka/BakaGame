import { describe, expect, test } from "bun:test";
import {
  chosenSongId,
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
import type { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import type { SonGuessrPrivateState, SonGuessrRoomSnapshot } from "../../src/shared/Index";
import { mcpFixture } from "../McpFixtures";

/**
 * 三种音源的上游播放地址形态：QQ 的文件名由歌曲 mid 拼成，网易云官方地址带文件哈希，
 * 解灰音源是第三方站点的任意地址。每种都带上能直接查出歌曲的字段与签名参数，
 * 用来证明这些东西不会出现在发给任何客户端的数据里。
 */
const SOURCES = [
  {
    label: "QQ 音乐",
    songId: "qq:002abcdefMIDxyz",
    audioUrl:
      "https://ws.stream.qqmusic.example/M500002abcdefMIDxyz002abcdefMIDxyz.mp3?guid=424242&vkey=SIGNATUREvkey",
    /** 上游地址里的主机、文件名与签名：任何客户端的任何数据里都不该出现。 */
    upstream: ["ws.stream.qqmusic.example", "qqmusic.example", "M500", "SIGNATUREvkey"],
    /** 能直接查出歌曲的标识：猜题的人看不到（出题人自己选的歌，他当然知道）。 */
    identity: ["002abcdefMIDxyz"],
  },
  {
    label: "网易云官方",
    songId: "netease:2468013579",
    audioUrl:
      "https://m801.music.example.net/20261112080000/0f1e2d3c4b5a69788796a5b4c3d2e1f0/jdyyaac/obj/w5rDlsOJwrLDjj7CmsOj/FILEHASH77.mp3",
    upstream: ["m801.music.example.net", "FILEHASH77", "0f1e2d3c4b5a6978", "w5rDlsOJwrLDjj7CmsOj"],
    identity: ["2468013579"],
  },
  {
    label: "网易云解灰",
    songId: "netease:1357924680",
    audioUrl: "https://unblock-mirror.example.org/stream/RID55667788.mp3?sign=ABCDEF&t=9",
    upstream: ["unblock-mirror.example.org", "RID55667788", "ABCDEF"],
    identity: ["1357924680"],
  },
] as const;

const PUBLIC_BASE = "https://api.example.com";
const TICKET_SHAPE = /^[A-Za-z0-9_-]{32,}$/;

const sourceProvider = (
  songId: string,
  audioUrl: () => string,
  extra: Partial<MusicProvider> = {}
): MusicProvider => ({
  ...provider,
  getSong: async (id) => ({ ...makeSong(id, "答案歌", 2022), audioUrl: audioUrl() }),
  getSongMetadata: async (id) => ({ ...makeSong(id, "答案歌", 2022), audioUrl: audioUrl() }),
  search: async () => [makeSong(songId, "答案歌", 2022)],
  ...extra,
});

const setup = async (
  musicProvider: MusicProvider,
  songId: string,
  options: { publicBaseUrl?: string } = {}
) => {
  const service = new SonGuessrService({
    musicProvider,
    random: { nextInt: () => 0 },
    ...options,
  });
  const host = connection(service, "audio-host");
  const guest = connection(service, "audio-guest");
  await createRoom(service, host);
  const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
  const guestState = await joinRoom(service, guest, "听众");
  await startRound(service, host, guest, hostState.playerId, songId);
  return { service, host, guest, hostState, guestState };
};

const snapshotOf = (client: TestConnection) =>
  lastEvent<SonGuessrRoomSnapshot>(client, "song.room.snapshot");

const ticketOf = (audioUrl: string | undefined): string => {
  const match = audioUrl?.match(/\/api\/songuessr\/audio\/1234\/([^/?#]+)$/);
  if (!match) throw new Error(`播放地址形态不对：${audioUrl}`);
  return match[1]!;
};

/** 让听众猜对并进入结算，用于检查揭晓之后的地址。 */
const finishRound = async (
  service: SonGuessrService,
  guest: TestConnection,
  songId: string,
  roundNumber = 1
) => {
  await execute(service, guest, {
    id: `audio-ready-${roundNumber}`,
    type: "song.game.audioReady",
    roomId: "1234",
    payload: { roundNumber },
  });
  await execute(service, guest, {
    id: `guess-${roundNumber}`,
    type: "song.game.guess",
    roomId: "1234",
    payload: { songId },
  });
};

describe("猜歌播放地址：站内票据地址", () => {
  for (const source of SOURCES) {
    test(`${source.label}：猜题阶段快照、私有态与 Agent 屏幕里搜不到上游信息`, async () => {
      const { service, host, guest } = await setup(
        sourceProvider(source.songId, () => source.audioUrl),
        source.songId,
        { publicBaseUrl: PUBLIC_BASE }
      );
      expect(snapshotOf(guest).phase).toBe("playing");
      expect(chosenSongId(service, "1234")).toBe(source.songId);

      // 全文搜索的对象是发给两个客户端的每一帧真实序列化结果：公共快照、各座位的私有态、事件。
      // 出题人（房主）自己选的歌，他的私有态里当然有歌曲标识；上游地址的任何部分他也不该拿到。
      const hostWire = JSON.stringify(host.sent);
      const guestWire = JSON.stringify(guest.sent);
      for (const leak of [...source.upstream, ".mp3"]) {
        expect(hostWire).not.toContain(leak);
        expect(guestWire).not.toContain(leak);
      }
      for (const leak of source.identity) expect(guestWire).not.toContain(leak);

      // Agent 屏幕按真实快照与私有态生成，另走一遍点击播放的反馈。
      const guestPrivate = lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState");
      const { ui } = mcpFixture({
        game: "song",
        snapshot: snapshotOf(guest) as unknown as Record<string, unknown>,
        privateState: guestPrivate as unknown as Record<string, unknown>,
      });
      const screen = await ui.screen("song");
      const run = await ui.run("song", [{ action: "click", control: "song.audio.play" }]);
      const agentWire = JSON.stringify([screen, run]);
      for (const leak of [...source.upstream, ...source.identity, ".mp3", "/api/songuessr/audio"]) {
        expect(agentWire).not.toContain(leak);
      }
    });

    test(`${source.label}：快照里是站内票据地址，揭晓后沿用同一个地址`, async () => {
      const { service, guest } = await setup(
        sourceProvider(source.songId, () => source.audioUrl),
        source.songId,
        { publicBaseUrl: PUBLIC_BASE }
      );
      const playingUrl = snapshotOf(guest).currentRound?.audioUrl;
      expect(playingUrl).toMatch(
        new RegExp(
          `^${PUBLIC_BASE.replace(/[.]/g, "\\.")}/api/songuessr/audio/1234/[A-Za-z0-9_-]+$`
        )
      );

      await finishRound(service, guest, source.songId);
      const result = snapshotOf(guest);
      expect(result.phase).toBe("roundResult");
      // 揭晓后答案已公开，但播放不能中断：整个回合继续用同一个站内地址，且仍然不是上游地址。
      expect(result.roundSummary?.song.audioUrl).toBe(playingUrl);
      expect(JSON.stringify(result)).not.toContain(source.audioUrl);
      // 揭晓后歌曲标识随答案公开，但上游的主机、文件名与签名仍然不该出现。
      for (const leak of source.upstream) expect(JSON.stringify(result)).not.toContain(leak);

      // Agent 屏幕的结算摘要同样不带任何音轨地址（它听不了音频，站内地址对它也没有用）。
      const { ui } = mcpFixture({
        game: "song",
        snapshot: result as unknown as Record<string, unknown>,
        privateState: lastEvent<SonGuessrPrivateState>(
          guest,
          "song.game.privateState"
        ) as unknown as Record<string, unknown>,
      });
      const agentWire = JSON.stringify(await ui.screen("song"));
      expect(agentWire).toContain("roundSummary");
      for (const leak of [...source.upstream, "audioUrl", "/api/songuessr/audio"]) {
        expect(agentWire).not.toContain(leak);
      }
    });
  }

  test("没有配置公开基址时下发相对路径，配置后下发绝对地址", async () => {
    const source = SOURCES[0];
    const relative = await setup(
      sourceProvider(source.songId, () => source.audioUrl),
      source.songId
    );
    const relativeUrl = snapshotOf(relative.guest).currentRound?.audioUrl;
    expect(relativeUrl).toMatch(/^\/api\/songuessr\/audio\/1234\/[A-Za-z0-9_-]+$/);

    // 旧壳把快照里的地址原样交给播放器：必须是带协议与主机的完整地址，尾部斜杠不能产生双斜杠。
    const absolute = await setup(
      sourceProvider(source.songId, () => source.audioUrl),
      source.songId,
      { publicBaseUrl: `${PUBLIC_BASE}/` }
    );
    const absoluteUrl = snapshotOf(absolute.guest).currentRound?.audioUrl;
    expect(absoluteUrl).toBe(`${PUBLIC_BASE}/api/songuessr/audio/1234/${ticketOf(absoluteUrl)}`);
    expect(() => new URL(absoluteUrl!)).not.toThrow();
  });

  test("票据足够长、每个回合不同，且不含房号与歌曲信息", async () => {
    const source = SOURCES[1];
    const tickets = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const { guest } = await setup(
        sourceProvider(source.songId, () => source.audioUrl),
        source.songId
      );
      const ticket = ticketOf(snapshotOf(guest).currentRound?.audioUrl);
      expect(ticket).toMatch(TICKET_SHAPE);
      // base64url 每字符 6 位：至少 128 位随机需要 22 个字符，实际取更长。
      expect(ticket.length).toBeGreaterThanOrEqual(22);
      expect(ticket).not.toContain("1234");
      expect(ticket).not.toContain("2468013579");
      tickets.add(ticket);
    }
    expect(tickets.size).toBe(20);
  });

  test("票据换回合即失效，新回合是另一枚", async () => {
    const source = SOURCES[0];
    const { service, host, guest } = await setup(
      sourceProvider(source.songId, () => source.audioUrl),
      source.songId
    );
    const first = ticketOf(snapshotOf(guest).currentRound?.audioUrl);
    expect(service.resolveAudioRedirect("1234", first)).toBe(source.audioUrl);

    await finishRound(service, guest, source.songId);
    // 结算阶段回合还在，同一个地址继续可用。
    expect(service.resolveAudioRedirect("1234", first)).toBe(source.audioUrl);

    await execute(service, host, {
      id: "next-round",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    // 进入下一轮的选歌流程：旧回合已经撤下，旧票据立即失效。
    expect(service.resolveAudioRedirect("1234", first)).toBeUndefined();
  });

  test("下一回合装题后拿到新票据，旧票据仍然失效", async () => {
    const source = SOURCES[1];
    const { service, host, guest, hostState, guestState } = await setup(
      sourceProvider(source.songId, () => source.audioUrl),
      source.songId
    );
    const first = ticketOf(snapshotOf(guest).currentRound?.audioUrl);
    await finishRound(service, guest, source.songId);
    await execute(service, host, {
      id: "next-round",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose-2",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "submit-2",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: source.songId },
    });
    void guestState;
    const second = ticketOf(snapshotOf(guest).currentRound?.audioUrl);
    expect(second).not.toBe(first);
    expect(service.resolveAudioRedirect("1234", first)).toBeUndefined();
    expect(service.resolveAudioRedirect("1234", second)).toBe(source.audioUrl);
  });

  test("房间不存在、房号不符、票据不符一律解析不出地址", async () => {
    const source = SOURCES[2];
    const { service, guest } = await setup(
      sourceProvider(source.songId, () => source.audioUrl),
      source.songId
    );
    const ticket = ticketOf(snapshotOf(guest).currentRound?.audioUrl);
    expect(service.resolveAudioRedirect("1234", ticket)).toBe(source.audioUrl);
    expect(service.resolveAudioRedirect("9999", ticket)).toBeUndefined();
    expect(service.resolveAudioRedirect("1234", `${ticket}x`)).toBeUndefined();
    expect(service.resolveAudioRedirect("1234", ticket.slice(0, -1))).toBeUndefined();
    expect(service.resolveAudioRedirect("1234", "")).toBeUndefined();
  });

  test("房间关闭后票据失效", async () => {
    const source = SOURCES[2];
    const { service, host, guest } = await setup(
      sourceProvider(source.songId, () => source.audioUrl),
      source.songId
    );
    const ticket = ticketOf(snapshotOf(guest).currentRound?.audioUrl);
    service.rooms.delete("1234");
    expect(service.resolveAudioRedirect("1234", ticket)).toBeUndefined();
    void host;
  });

  test("重连刷新只换上游地址，票据地址不变", async () => {
    const source = SOURCES[0];
    let loads = 0;
    const { service, guest, guestState } = await setup(
      sourceProvider(source.songId, () => `${source.audioUrl}&load=${++loads}`),
      source.songId
    );
    const before = snapshotOf(guest).currentRound?.audioUrl;
    const ticket = ticketOf(before);
    const loadsBefore = loads;
    const stale = service.resolveAudioRedirect("1234", ticket);
    expect(stale).toBe(`${source.audioUrl}&load=${loadsBefore}`);

    await service.unregisterConnection(guest.record.id);
    const refreshed = connection(service, "audio-guest-new");
    await execute(service, refreshed, {
      id: "reconnect",
      type: "song.room.reconnect",
      payload: { roomId: "1234", sessionToken: guestState.sessionToken },
    });
    expect(snapshotOf(refreshed).currentRound?.audioUrl).toBe(before);
    // 再次请求同一个票据地址拿到的是刷新后的上游地址。
    const fresh = service.resolveAudioRedirect("1234", ticket);
    expect(fresh).toBe(`${source.audioUrl}&load=${loads}`);
    expect(fresh).not.toBe(stale);
  });

  test("播放失败后的刷新同样不换票据，重新请求拿到新的上游地址", async () => {
    const source = SOURCES[1];
    let loads = 0;
    const { service, guest } = await setup(
      sourceProvider(source.songId, () => `${source.audioUrl}?n=${++loads}`, {
        refreshSongAudio: async () => `${source.audioUrl}?refreshed=1`,
      }),
      source.songId
    );
    const ticket = ticketOf(snapshotOf(guest).currentRound?.audioUrl);
    const before = service.resolveAudioRedirect("1234", ticket);
    await expect(
      execute(service, guest, {
        id: "audio-failed",
        type: "song.game.audioFailed",
        roomId: "1234",
        payload: { roundNumber: 1 },
      })
    ).resolves.toMatchObject({ refreshed: true });
    expect(ticketOf(snapshotOf(guest).currentRound?.audioUrl)).toBe(ticket);
    expect(service.resolveAudioRedirect("1234", ticket)).toBe(`${source.audioUrl}?refreshed=1`);
    expect(service.resolveAudioRedirect("1234", ticket)).not.toBe(before);
  });

  test("停机快照不落票据，恢复后重新签发，落盘的旧票据不可用", async () => {
    const source = SOURCES[1];
    const { service, guest } = await setup(
      sourceProvider(source.songId, () => source.audioUrl),
      source.songId
    );
    const ticket = ticketOf(snapshotOf(guest).currentRound?.audioUrl);
    const exported = service.exportSnapshots();
    expect(JSON.stringify(exported)).not.toContain(ticket);

    const restored = new SonGuessrService({
      musicProvider: sourceProvider(source.songId, () => source.audioUrl),
    });
    expect(restored.restoreSnapshots(exported, Date.now())).toBe(1);
    expect(restored.resolveAudioRedirect("1234", ticket)).toBeUndefined();
    const newTicket = restored.rooms.get("1234")?.currentRound?.audioTicket;
    expect(newTicket).toMatch(TICKET_SHAPE);
    expect(newTicket).not.toBe(ticket);
    expect(restored.resolveAudioRedirect("1234", newTicket!)).toBe(source.audioUrl);
  });

  test("上一版本落盘的结算摘要里的上游地址不会被下发", async () => {
    const source = SOURCES[1];
    const { service, guest, guestState } = await setup(
      sourceProvider(source.songId, () => source.audioUrl),
      source.songId
    );
    await finishRound(service, guest, source.songId);
    const exported = service.exportSnapshots();
    // 旧版本把上游地址写进了摘要：恢复出来的房间不能把它原样发给客户端。
    const summary = (exported[0] as unknown as { roundSummary: { song: Record<string, unknown> } })
      .roundSummary;
    summary.song.audioUrl = source.audioUrl;
    const restored = new SonGuessrService({
      musicProvider: sourceProvider(source.songId, () => source.audioUrl),
    });
    restored.restoreSnapshots(exported, Date.now());
    const reader = connection(restored, "audio-reader");
    await execute(restored, reader, {
      id: "reconnect",
      type: "song.room.reconnect",
      payload: { roomId: "1234", sessionToken: guestState.sessionToken },
    });
    const result = snapshotOf(reader);
    expect(result.phase).toBe("roundResult");
    expect(result.roundSummary?.song.audioUrl).toMatch(/^\/api\/songuessr\/audio\/1234\//);
    const dumped = JSON.stringify(reader.sent);
    expect(dumped).not.toContain(source.audioUrl);
    expect(dumped).not.toContain("m801.music.example.net");
  });
});
