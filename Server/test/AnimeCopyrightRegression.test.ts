import { describe, expect, test } from "bun:test";

import { isSongTitleMatch, SonGuessrService } from "../src/application/SonGuessrService";
import type { ConnectionRecord } from "../src/domain/Model";
import type { MusicProvider } from "../src/infrastructure/NeteaseMusicProvider";
import type { BangumiDataProvider } from "../src/infrastructure/LocalBangumiProvider";
import {
  isBangumiCreditsEntry,
  type BangumiSubjectDetails,
  type SongDetails,
  type SonGuessrClientMessage,
  type SonGuessrRoomSnapshot,
} from "../src/shared/Index";

const makeSong = (id: string, title: string, album: string, artist: string): SongDetails => ({
  id,
  title,
  artist,
  album,
  pictureUrl: `https://img/${id}.jpg`,
  durationMs: 180_000,
  audioUrl: `https://audio/${id}.mp3`,
  lyrics: Array.from({ length: 8 }, (_, i) => ({
    time: (i + 1) * 1_000,
    endTime: (i + 2) * 1_000,
    text: `歌词${i + 1}`,
  })),
  releaseYear: 2019,
  popularity: 60,
  language: "日语",
  encyclopedia: { tags: ["音乐"] },
});

// 复刻生产数据集中的真实事故：MyGO 关联条目第一条是版权伪条目且被标成 opening。
// 真实 MyGO 正 id 曲目只有 14 条（壱雫空 / 迷跡波 / Sasanqua …），版权伪条目必须被剔除。
const myGo: BangumiSubjectDetails = {
  id: "428735",
  name: "BanG Dream! It's MyGO!!!!!",
  nameCn: "BanG Dream! It's MyGO!!!!!",
  tags: ["BanGDream", "原创"],
  metaTags: [],
  musicTracks: [
    { title: "©BanG Dream! Project", kind: "opening" },
    { title: "壱雫空", kind: "ending" },
  ],
};

// 网易云真实存在的、与 MyGO 无关的 2019 年专辑《Music For All》曲目。
const unrelated = makeSong("mfa", "Bang Dream!", "Music For All", "Tachibana Mikuru");
const correct = makeSong("ichizu", "壱雫空", "壱雫空", "MyGO!!!!!");

const provider: MusicProvider = {
  search: async () => [unrelated, correct],
  getSong: async (id) => (id === "mfa" ? unrelated : correct),
  getSongMetadata: async (id) => (id === "mfa" ? unrelated : correct),
  getLoginStatus: async (cookie) => ({ cookie, account: { nickname: "测试账号" } }),
};

interface TestConnection {
  record: ConnectionRecord;
  sent: Array<{ type?: string; event?: string; payload?: unknown }>;
}

const connection = (service: SonGuessrService, id: string): TestConnection => {
  const sent: TestConnection["sent"] = [];
  const record: ConnectionRecord = {
    id,
    lobbySubscribed: false,
    send: (payload) => sent.push(payload as TestConnection["sent"][number]),
    close: () => {},
  };
  service.registerConnection(record);
  return { record, sent };
};

const execute = (
  service: SonGuessrService,
  client: TestConnection,
  message: SonGuessrClientMessage,
) => service.execute(client.record.id, message);

const lastEvent = <T>(client: TestConnection, event: string): T =>
  client.sent.filter((item) => item.type === "event" && item.event === event).at(-1)!.payload as T;

describe("猜番版权伪条目防护", () => {
  test("版权署名条目识别只认无歧义标记，不误伤带美术字符的正常曲名", () => {
    // 必须命中：制作方 / 版权方署名，数据集实测全部为负 music_id 占位行。
    for (const title of [
      "©BanG Dream! Project",
      "©SUNRISE",
      "©Visual Art's",
      "©2007 竜騎士07",
      "(C)manglobe",
      "（C）2006 SUNRISE inc.",
      "（Ｃ）ＴＹＰＥ－ＭＯＯＮ",
      "Ⓒ 創通・タツノコプロ",
      "時をかける少女」製作委員会2006",
      "映画「ガラスのうさぎ」製作委員会",
      "",
    ]) {
      expect(isBangumiCreditsEntry(title)).toBe(true);
    }

    // 绝不能命中：这些是正 id 的真实歌曲，曾被过激规则误杀 126 首。
    for (const title of [
      "unconditional L♡VE",
      "♡km/h",
      "Love❤Island",
      "μ's オリジナルソングCD⑤ にこぷり♡女子道",
      "のだめカンタービレ フィナーレ オールシーズンズベスト",
      "オールOK!!",
      "壱雫空",
      "You♡I -SWEET TUNED BY 5pb.- / 榊原ゆい",
    ]) {
      expect(isBangumiCreditsEntry(title)).toBe(false);
    }
  });

  test("曲名门禁不得把版权署名与正常曲名判为同一首", () => {
    // 修复前：子串匹配让 `©BanG Dream! Project` 包含 `bangdream`，误判为 true，
    // 正是截图事故的判定根因。
    expect(isSongTitleMatch("Bang Dream!", "©BanG Dream! Project")).toBe(false);
    expect(isSongTitleMatch("©SUNRISE", "SUNRISE")).toBe(false);
    // 正常兼容版本仍须通过门禁。
    expect(isSongTitleMatch("壱雫空", "壱雫空")).toBe(true);
    expect(isSongTitleMatch("Cagayake!GIRLS [5人Ver.]", "Cagayake!GIRLS")).toBe(true);
  });

  test("自动猜番不得把版权伪条目当成 OP 去网易云搜歌", async () => {
    const bangumiProvider = {
      searchSubjects: async () => [myGo],
      getSubject: async () => myGo,
    } as unknown as BangumiDataProvider;
    const service = new SonGuessrService({ musicProvider: provider, bangumiProvider });
    const host = connection(service, "anime-credits-host");
    const guest = connection(service, "anime-credits-guest");

    await execute(service, host, {
      id: "create",
      type: "song.room.create",
      payload: {
        roomId: "1234",
        name: "猜番房",
        visibility: "public",
        allowSpectators: true,
        userName: "房主",
      },
    });
    await execute(service, host, {
      id: "account",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=test" },
    });
    await execute(service, guest, {
      id: "join",
      type: "song.room.join",
      roomId: "1234",
      payload: { userName: "猜番玩家" },
    });
    await execute(service, host, {
      id: "settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionType: "anime", questionMode: "automatic" },
    });
    await execute(service, guest, {
      id: "ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, { id: "start", type: "song.game.start", roomId: "1234", payload: {} });

    // 修复前抽到与番剧无关的《Music For All》（unrelated）；
    // 修复后必须落到与 MyGO 真正相关的《壱雫空》。
    const round = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound;
    expect(round?.audioUrl).toBe(correct.audioUrl);
  });
});
