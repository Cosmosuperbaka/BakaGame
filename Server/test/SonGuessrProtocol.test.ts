import { expect, test } from "bun:test";

import {
  hasMusicAccount,
  SonGuessrMessageSchemas,
  SonGuessrPayloadSchemas,
  type SonGuessrCommand,
} from "../src/shared/SonGuessr";
import { parseSonGuessrMessage } from "../src/transport/SonGuessrProtocol";

test("SonGuessr 协议解析房间设置与游戏命令", () => {
  expect(
    parseSonGuessrMessage({
      id: "sync",
      type: "song.room.requestSync",
      roomId: "1234",
      payload: {},
    })
  ).toMatchObject({ type: "song.room.requestSync", payload: {} });

  expect(
    parseSonGuessrMessage({
      id: "1",
      type: "song.room.updateSettings",
      roomId: "1234",
      sessionToken: "token",
      payload: {
        lyricsLineCount: 7,
        showLyrics: false,
        autoRotateSubmitter: true,
        bloodMode: true,
        showGuessTimer: false,
        allowSpectators: false,
      },
    })
  ).toMatchObject({
    type: "song.room.updateSettings",
    roomId: "1234",
    payload: {
      lyricsLineCount: 7,
      showLyrics: false,
      autoRotateSubmitter: true,
      bloodMode: true,
      showGuessTimer: false,
      allowSpectators: false,
    },
  });
});

test("SonGuessr 协议解析题目设置与自动筛选", () => {
  expect(
    parseSonGuessrMessage({
      id: "question-settings",
      type: "song.room.updateSettings",
      payload: {
        questionType: "song",
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "123", name: "测试歌单", songCount: 10 },
          artists: [{ id: "7", name: "测试歌手" }],
          minPopularity: 10_000,
        },
      },
    })
  ).toMatchObject({
    payload: {
      questionType: "song",
      questionMode: "automatic",
      autoFilters: {
        playlist: { id: "123" },
        artists: [{ id: "7", name: "测试歌手" }],
        minPopularity: 10_000,
      },
    },
  });
});

test("SonGuessr 热度门槛接受 0 到 1000000 的整数，越界与小数拒收", () => {
  const settings = (minPopularity: number) => ({
    id: `popularity-${minPopularity}`,
    type: "song.room.updateSettings",
    payload: {
      autoFilters: { artists: [], minPopularity },
      animeAutoFilters: { songMinPopularity: minPopularity },
    },
  });
  for (const value of [0, 2_000, 350_000, 1_000_000]) {
    expect(parseSonGuessrMessage(settings(value))).toMatchObject({
      payload: {
        autoFilters: { minPopularity: value },
        animeAutoFilters: { songMinPopularity: value },
      },
    });
  }
  for (const value of [-1, 1_000_001, 1.5]) {
    expect(() => parseSonGuessrMessage(settings(value))).toThrow(
      expect.objectContaining({ code: "INVALID_MESSAGE" })
    );
  }
});

test("SonGuessr 协议解析听歌猜番新筛选并拒绝旧字段", () => {
  expect(
    parseSonGuessrMessage({
      id: "anime-filters",
      type: "song.room.updateSettings",
      payload: {
        animeAutoFilters: {
          startYear: 2016,
          endYear: 2026,
          ranking: "all",
          subjectLimit: 50,
          songMinPopularity: 10_000,
          trackKinds: ["opening", "ending"],
        },
      },
    })
  ).toMatchObject({
    payload: {
      animeAutoFilters: {
        ranking: "all",
        subjectLimit: 50,
        songMinPopularity: 10_000,
        trackKinds: ["opening", "ending"],
      },
    },
  });
  expect(() =>
    parseSonGuessrMessage({
      id: "legacy-anime-filters",
      type: "song.room.updateSettings",
      payload: { animeAutoFilters: { topN: 50 } },
    })
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
});

test("SonGuessr 协议解析听歌猜番搜索与游戏命令", () => {
  expect(
    parseSonGuessrMessage({
      id: "bangumi-search",
      type: "song.bangumi.search",
      roomId: "1234",
      sessionToken: "token",
      payload: { keyword: "命运石之门" },
    })
  ).toMatchObject({
    type: "song.bangumi.search",
    payload: { keyword: "命运石之门" },
  });

  expect(
    parseSonGuessrMessage({
      id: "bangumi-songs",
      type: "song.bangumi.songs",
      roomId: "1234",
      sessionToken: "token",
      payload: { subjectId: "10380" },
    })
  ).toMatchObject({
    type: "song.bangumi.songs",
    payload: { subjectId: "10380" },
  });

  expect(
    parseSonGuessrMessage({
      id: "submit-anime",
      type: "song.game.submitAnime",
      roomId: "1234",
      payload: { subjectId: "10380", songId: "228228" },
    })
  ).toMatchObject({
    type: "song.game.submitAnime",
    payload: { subjectId: "10380", songId: "228228" },
  });

  expect(
    parseSonGuessrMessage({
      id: "guess-anime",
      type: "song.game.guessAnime",
      roomId: "1234",
      payload: { subjectId: "1701" },
    })
  ).toMatchObject({
    type: "song.game.guessAnime",
    payload: { subjectId: "1701" },
  });

  expect(() =>
    parseSonGuessrMessage({
      id: "dirty-anime",
      type: "song.game.guessAnime",
      payload: { subjectId: "1701", extra: true },
    })
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
});

test("SonGuessr 协议拒绝非法音频准备回合号", () => {
  for (const roundNumber of ["1", 0, -1, 1.5]) {
    expect(() =>
      parseSonGuessrMessage({
        id: "1",
        type: "song.game.audioReady",
        payload: { roundNumber },
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
  }
});

test("SonGuessr 协议解析旁观、放弃与测试人机命令", () => {
  expect(
    parseSonGuessrMessage({
      id: "spectator",
      type: "song.player.setSpectator",
      payload: { spectator: true },
    })
  ).toMatchObject({ type: "song.player.setSpectator", payload: { spectator: true } });

  expect(
    parseSonGuessrMessage({
      id: "give-up",
      type: "song.game.giveUp",
      payload: {},
    })
  ).toMatchObject({ type: "song.game.giveUp", payload: {} });

  expect(
    parseSonGuessrMessage({
      id: "bots",
      type: "song.test.addBot",
      payload: { count: 3 },
    })
  ).toMatchObject({ type: "song.test.addBot", payload: { count: 3 } });

  for (const count of [0, -1, 1.5, "2"]) {
    expect(() =>
      parseSonGuessrMessage({
        id: "invalid-bots",
        type: "song.test.removeBot",
        payload: { count },
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
  }
});

test("SonGuessr 协议只解析扫码与 Cookie 登录命令", () => {
  expect(
    parseSonGuessrMessage({
      id: "qr",
      type: "song.auth.qr.check",
      payload: { key: "qr-key" },
    })
  ).toMatchObject({ type: "song.auth.qr.check", payload: { key: "qr-key" } });

  for (const type of ["song.auth.phone.login", "song.auth.email.login"]) {
    expect(() => parseSonGuessrMessage({ id: "removed-login", type, payload: {} })).toThrow(
      expect.objectContaining({ code: "UNKNOWN_MESSAGE_TYPE" })
    );
  }

  expect(
    parseSonGuessrMessage({
      id: "cookie",
      type: "song.auth.useCookie",
      payload: { cookie: "MUSIC_U=test" },
    })
  ).toMatchObject({ type: "song.auth.useCookie", payload: { cookie: "MUSIC_U=test" } });
});

test("SonGuessr 协议严格拦截 payload null 与未知属性", () => {
  // 1. 拒绝 payload: null
  expect(() =>
    parseSonGuessrMessage({
      id: "null-payload",
      type: "song.room.leave",
      payload: null,
    })
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));

  // 2. 拒绝未声明的信封脏字段
  expect(() =>
    parseSonGuessrMessage({
      id: "extra-envelope",
      type: "song.room.leave",
      payload: {},
      extraField: "hacker",
    })
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));

  // 3. 拒绝未声明的 payload 脏字段
  expect(() =>
    parseSonGuessrMessage({
      id: "extra-payload",
      type: "song.room.leave",
      payload: { dirty: 123 },
    })
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
});

test("SonGuessr 协议支持 16,384 字符合法 Cookie 并拦截超长凭据", () => {
  // 501~16384 字符的 Cookie 应被正常解析放行
  const validLongCookie = "MUSIC_U=" + "a".repeat(1000);
  const parsed = parseSonGuessrMessage({
    id: "long-cookie",
    type: "song.auth.useCookie",
    payload: { cookie: validLongCookie },
  });
  expect((parsed.payload as { cookie: string }).cookie).toBe(validLongCookie);

  const maxValidCookie = "a".repeat(16_384);
  const parsedMax = parseSonGuessrMessage({
    id: "max-cookie",
    type: "song.auth.useCookie",
    payload: { cookie: maxValidCookie },
  });
  expect((parsedMax.payload as { cookie: string }).cookie).toBe(maxValidCookie);

  // 超过 16384 字符必须被拦截
  const tooLongCookie = "a".repeat(16_385);
  expect(() =>
    parseSonGuessrMessage({
      id: "too-long-cookie",
      type: "song.auth.useCookie",
      payload: { cookie: tooLongCookie },
    })
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
});

test("局部自动筛选输入和完整房间状态拥有不同契约", async () => {
  const { Value } = await import("@sinclair/typebox/value");
  const { SongAutoFiltersSchema, SongAutoFiltersInputSchema } =
    await import("../src/shared/SonGuessrFilters");
  const partial = { playlist: { id: "1" } };
  expect(Value.Check(SongAutoFiltersInputSchema, partial)).toBe(true);
  expect(Value.Check(SongAutoFiltersSchema, partial)).toBe(false);
  expect(
    parseSonGuessrMessage({
      id: "filters",
      type: "song.room.updateSettings",
      payload: { autoFilters: partial },
    })
  ).toMatchObject({ payload: { autoFilters: partial } });
});

test("SonGuessr 协议正确放行网易云与 QQ 音乐统一 URN 歌曲 ID (含冒号)", () => {
  // 1. song.game.submitSong
  expect(
    parseSonGuessrMessage({
      id: "submit-netease",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "netease:1899705498" },
    })
  ).toMatchObject({
    type: "song.game.submitSong",
    payload: { songId: "netease:1899705498" },
  });

  expect(
    parseSonGuessrMessage({
      id: "submit-qq",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "qq:0017K7gL4WYnw2" },
    })
  ).toMatchObject({
    type: "song.game.submitSong",
    payload: { songId: "qq:0017K7gL4WYnw2" },
  });

  // 2. song.game.guess
  expect(
    parseSonGuessrMessage({
      id: "guess-qq",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "qq:0017K7gL4WYnw2" },
    })
  ).toMatchObject({
    type: "song.game.guess",
    payload: { songId: "qq:0017K7gL4WYnw2" },
  });

  // 3. song.game.submitAnime (带 URN)
  expect(
    parseSonGuessrMessage({
      id: "anime-urn",
      type: "song.game.submitAnime",
      roomId: "1234",
      payload: { subjectId: "10380", songId: "netease:1899705498" },
    })
  ).toMatchObject({
    type: "song.game.submitAnime",
    payload: { subjectId: "10380", songId: "netease:1899705498" },
  });

  // 4. 拒绝包含特殊字符或超长的非法 ID
  expect(() =>
    parseSonGuessrMessage({
      id: "dirty-song-id",
      type: "song.game.submitSong",
      payload: { songId: "qq:001<script>" },
    })
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
});

// ==================== 命令清单不变量（F01 的复发守卫） ====================

/**
 * 每一条猜歌命令的**最小可发送载荷**，逐条硬编码。
 *
 * 这份清单是命令契约的第三份见证：shared 的载荷表派生类型与信封，服务端的 switch 处理命令，
 * 而这里断言「客户端发得出来的每一条命令都能过传输层解析」。`song.subject.image` 当年正是
 * 类型、处理器、客户端调用三处都有、唯独传输层 schema 漏键，19 条协议测试全绿而功能静默失效。
 * 删掉载荷表里任一条命令，本用例必然变红。
 */
const SONGUESSR_COMMAND_CASES = [
  { type: "song.lobby.subscribeRooms", payload: {} },
  {
    type: "song.room.create",
    payload: {
      roomId: "1234",
      name: "房间",
      visibility: "public",
      allowSpectators: true,
      userName: "玩家",
    },
  },
  { type: "song.room.join", payload: { userName: "玩家" } },
  { type: "song.room.reconnect", payload: { roomId: "1234", sessionToken: "session" } },
  { type: "song.room.leave", payload: {} },
  { type: "song.room.requestSync", payload: {} },
  { type: "song.player.setReady", payload: { ready: true } },
  { type: "song.player.setSpectator", payload: { spectator: true } },
  { type: "song.player.setTeam", payload: { team: null } },
  { type: "song.room.updateSettings", payload: { showLyrics: true } },
  { type: "song.room.kick", payload: { playerId: "p1" } },
  { type: "song.room.transferHost", payload: { playerId: "p1" } },
  { type: "song.chat.send", payload: { text: "你好" } },
  { type: "song.chat.plusOne", payload: { messageId: "song-chat-1" } },
  { type: "song.auth.qr.create", payload: {} },
  { type: "song.auth.qr.check", payload: { key: "qr-key" } },
  { type: "song.auth.useCookie", payload: { cookie: "MUSIC_U=test" } },
  { type: "song.auth.clear", payload: {} },
  { type: "song.auth.setPoolSharing", payload: { platform: "qq", enabled: true } },
  { type: "song.music.search", payload: { keyword: "测试" } },
  { type: "song.music.detail", payload: { songId: "netease:1899705498" } },
  { type: "song.music.playlist.resolve", payload: { value: "123" } },
  { type: "song.music.artist.search", payload: { keyword: "测试" } },
  { type: "song.bangumi.search", payload: { keyword: "测试" } },
  { type: "song.bangumi.songs", payload: { subjectId: "10380" } },
  { type: "song.subject.image", payload: { subjectId: "10380" } },
  { type: "song.game.start", payload: {} },
  { type: "song.game.chooseSubmitter", payload: { playerId: "p1" } },
  { type: "song.game.submitSong", payload: { songId: "netease:1899705498" } },
  { type: "song.game.submitAnime", payload: { subjectId: "10380" } },
  { type: "song.game.audioReady", payload: { roundNumber: 1 } },
  { type: "song.game.audioFailed", payload: { roundNumber: 1 } },
  { type: "song.game.guess", payload: { songId: "qq:0017K7gL4WYnw2" } },
  { type: "song.game.guessAnime", payload: { subjectId: "1701" } },
  { type: "song.game.giveUp", payload: {} },
  { type: "song.game.skipRound", payload: {} },
  { type: "song.game.nextRound", payload: {} },
  { type: "song.game.finish", payload: {} },
  { type: "song.test.addBot", payload: {} },
  { type: "song.test.removeBot", payload: {} },
] as const satisfies readonly { type: SonGuessrCommand; payload: Record<string, unknown> }[];

type UnprobedSonGuessrCommand = Exclude<
  SonGuessrCommand,
  (typeof SONGUESSR_COMMAND_CASES)[number]["type"]
>;
const everySonGuessrCommandProbed: UnprobedSonGuessrCommand extends never ? true : never = true;

/** `Object.keys` 只给 `string[]`，比对前统一放宽，键集本身仍由上面的 satisfies/Exclude 锁死。 */
const sortedNames = (values: readonly string[]): string[] => [...values].sort();

test("猜歌命令表与传输层信封键集完全一致", () => {
  expect(everySonGuessrCommandProbed).toBe(true);
  const payloadKeys = sortedNames(Object.keys(SonGuessrPayloadSchemas));
  expect(sortedNames(Object.keys(SonGuessrMessageSchemas))).toEqual(payloadKeys);
  expect(sortedNames(SONGUESSR_COMMAND_CASES.map((item) => item.type))).toEqual(payloadKeys);
});

test("猜歌每一条命令都能通过传输层解析", () => {
  for (const { type, payload } of SONGUESSR_COMMAND_CASES) {
    const parsed = parseSonGuessrMessage({
      id: `probe-${type}`,
      type,
      roomId: "1234",
      payload,
    });
    expect(parsed.type).toBe(type);
  }
});

test("猜歌信封骨架统一为六个字段且保持严格", () => {
  for (const schema of Object.values(SonGuessrMessageSchemas)) {
    expect(Object.keys(schema.properties).sort()).toEqual([
      "id",
      "payload",
      "roomId",
      "sessionToken",
      "traceId",
      "type",
    ]);
    expect([...schema.required].sort()).toEqual(["id", "payload", "type"]);
    expect(schema.additionalProperties).toBe(false);
  }
});

test("song.subject.image 封面补图命令可解析并拒绝脏字段", () => {
  expect(
    parseSonGuessrMessage({
      id: "subject-image",
      type: "song.subject.image",
      roomId: "1234",
      payload: { subjectId: "1701" },
    })
  ).toMatchObject({ type: "song.subject.image", payload: { subjectId: "1701" } });

  expect(() =>
    parseSonGuessrMessage({
      id: "subject-image-dirty",
      type: "song.subject.image",
      payload: { subjectId: "1701", extra: true },
    })
  ).toThrow(expect.objectContaining({ code: "INVALID_MESSAGE" }));
});

test("开局账号条件：网易云与 QQ 任一可用即可", () => {
  expect(hasMusicAccount({ musicAccountReady: true, qqMusicAccountReady: false })).toBe(true);
  expect(hasMusicAccount({ musicAccountReady: false, qqMusicAccountReady: true })).toBe(true);
  expect(hasMusicAccount({ musicAccountReady: true, qqMusicAccountReady: true })).toBe(true);
  expect(hasMusicAccount({ musicAccountReady: false, qqMusicAccountReady: false })).toBe(false);
  expect(hasMusicAccount({ musicAccountReady: false })).toBe(false);
});
