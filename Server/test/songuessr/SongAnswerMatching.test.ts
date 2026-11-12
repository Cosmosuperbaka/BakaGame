import { describe, expect, test } from "bun:test";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import { isSameAnswerSong } from "../../src/application/songuessr/SongTitleMatching";
import { MusicProvider } from "../../src/infrastructure/NeteaseMusicProvider";
import { type SongDetails } from "../../src/shared/Index";
import {
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  makeSong,
  startRound,
} from "./Fixtures";
import { type SonGuessrPrivateState } from "../../src/shared/Index";

const song = (id: string, title: string, artist: string): SongDetails => ({
  ...makeSong(id, title, 2020),
  artist,
});

describe("猜歌判对规则", () => {
  const cases: Array<{
    name: string;
    guess: SongDetails;
    answer: SongDetails;
    alternateIds?: string[];
    expected: boolean;
  }> = [
    {
      name: "歌曲 id 相同",
      guess: song("a", "晴天", "周杰伦"),
      answer: song("a", "完全不同", "别人"),
      expected: true,
    },
    {
      name: "猜中答案的备用音源 id",
      guess: song("qq:2", "另一个写法", "另一个歌手"),
      answer: song("163:1", "晴天", "周杰伦"),
      alternateIds: ["qq:2"],
      expected: true,
    },
    {
      name: "繁体曲名与简体曲名",
      guess: song("qq:1", "爱的魔法", "周杰伦"),
      answer: song("163:1", "愛的魔法", "周杰倫"),
      expected: true,
    },
    {
      name: "歌手别名写法不同",
      guess: song("qq:1", "ありがとう", "生物股长"),
      answer: song("163:1", "ありがとう", "いきものがかり"),
      expected: true,
    },
    {
      name: "全角半角与大小写",
      guess: song("qq:1", "ＬＯＶＥ　Story", "Taylor"),
      answer: song("163:1", "love story", "taylor"),
      expected: true,
    },
    {
      name: "括号里的版本信息不影响曲名",
      guess: song("qq:1", "晴天 (Live)", "周杰伦"),
      answer: song("163:1", "晴天", "周杰伦"),
      expected: true,
    },
    {
      name: "多歌手署名只要有交集",
      guess: song("qq:1", "合唱曲", "歌手甲 & 歌手乙"),
      answer: song("163:1", "合唱曲", "歌手乙"),
      expected: true,
    },
    {
      name: "纯符号曲名归一后为空，不能互相判对",
      guess: song("qq:1", "！！！", "同一歌手"),
      answer: song("163:1", "？？？", "同一歌手"),
      expected: false,
    },
    {
      name: "曲名相同但歌手无交集",
      guess: song("qq:1", "晴天", "歌手甲"),
      answer: song("163:1", "晴天", "歌手乙"),
      expected: false,
    },
    {
      name: "歌手相同但曲名不同",
      guess: song("qq:1", "夜曲", "周杰伦"),
      answer: song("163:1", "晴天", "周杰伦"),
      expected: false,
    },
    {
      name: "备用 id 不含该猜测时仍按曲名判",
      guess: song("qq:9", "夜曲", "周杰伦"),
      answer: song("163:1", "晴天", "周杰伦"),
      alternateIds: ["qq:2"],
      expected: false,
    },
  ];

  test.each(cases)("$name", ({ guess, answer, alternateIds, expected }) => {
    expect(isSameAnswerSong(guess, answer, alternateIds ?? [])).toBe(expected);
  });

  test("经猜歌命令作答：繁简与别名写法的另一平台条目判对", async () => {
    const answer = song("answer", "愛的魔法", "いきものがかり");
    const sameWork = song("qq:77", "爱的魔法", "生物股长");
    const symbolsA = song("qq:78", "！！！", "いきものがかり");
    const musicProvider: MusicProvider = {
      search: async () => [],
      getSong: async () => answer,
      getSongMetadata: async (id) => (id === sameWork.id ? sameWork : symbolsA),
      getLoginStatus: async (cookie) => ({ cookie, account: { nickname: "测试账号" } }),
    };
    const service = new SonGuessrService({ musicProvider, random: { nextInt: () => 0 } });
    const host = connection(service, "match-host");
    const guest = connection(service, "match-guest");
    await createRoom(service, host);
    const hostId = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").playerId;
    await joinRoom(service, guest, "猜歌玩家");
    await startRound(service, host, guest, hostId);
    await execute(service, guest, {
      id: "match-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    const send = (id: string, songId: string) =>
      execute<{ attempt: { result: string } }>(service, guest, {
        id,
        type: "song.game.guess",
        roomId: "1234",
        payload: { songId },
      });
    // 纯符号曲名与答案的曲名并不相同，不能因为归一后都是空串被判对。
    await expect(send("match-symbols", symbolsA.id)).resolves.toMatchObject({
      attempt: { result: "wrong" },
    });
    await expect(send("match-same-work", sameWork.id)).resolves.toMatchObject({
      attempt: { result: "correct" },
    });
  });
});
