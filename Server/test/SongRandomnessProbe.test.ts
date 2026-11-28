import { expect, test } from "bun:test";
import { expectedUnique, measureSequence } from "../scripts/SongRandomnessProbe";

test("选歌实测区分全局重复和最近十首重复", () => {
  expect(measureSequence(["a", "b", "a", "a"])).toMatchObject({
    rounds: 4,
    unique: 2,
    repeats: 2,
    repeatRate: 0.5,
    adjacentRepeats: 1,
    recentTenRepeats: 2,
    minimumGap: 1,
    firstRepeatRound: 3,
    maximumAppearances: 3,
  });
  expect(measureSequence([])).toMatchObject({
    repeatRate: 0,
    minimumGap: null,
    firstRepeatRound: null,
  });
  const window = Array.from({ length: 11 }, (_, index) => String(index));
  expect(measureSequence([...window, "0"])).toMatchObject({
    repeats: 1,
    recentTenRepeats: 0,
    minimumGap: 11,
  });
});

test("理论唯一数按生产选歌策略：整池出完一遍之前不重复", () => {
  expect(expectedUnique(0, 10)).toBe(0);
  expect(expectedUnique(15, 12)).toBe(12);
  expect(expectedUnique(15, 30)).toBe(15);
  expect(expectedUnique(10, 30)).toBe(10);
  expect(expectedUnique(500, 800)).toBe(500);
  // 记录装不下整池时，前 501 轮仍然不重复，之后才在最近 500 首之外均匀抽。
  expect(expectedUnique(1000, 400)).toBe(400);
  expect(expectedUnique(1000, 501)).toBe(501);
  expect(expectedUnique(1000, 600)).toBeCloseTo(1000 - 499 * (1 - 1 / 500) ** 99);
});

test("实测驱动执行真实回合并保留最近十首防重行为", async () => {
  const { createProbeRoom } = await import("../scripts/SongRandomnessProbe");
  const songs = Array.from({ length: 15 }, (_, index) => ({
    id: String(index),
    title: `隔离曲目${index}`,
    artist: "测试歌手",
    audioUrl: "https://audio.example.test/fixture.mp3",
    lyrics: [],
    encyclopedia: { tags: [] },
  }));
  const info = { id: "100001", name: "隔离歌单", songCount: songs.length };
  const room = await createProbeRoom(
    {
      search: async () => [],
      getPlaylistSongs: async () => ({ info, songs }),
      getSong: async (id) => songs.find((song) => song.id === id)!,
      getSongMetadata: async (id) => songs.find((song) => song.id === id)!,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { nickname: "夹具账号", vipStatus: "nonVip" },
      }),
    },
    "MUSIC_U=fixture",
    info
  );
  const sequence: string[] = [];
  try {
    for (let index = 0; index < 40; index++) sequence.push(await room.next());
  } finally {
    await room.close();
  }
  const metrics = measureSequence(sequence);
  expect(metrics.rounds).toBe(40);
  // 15 首打 40 轮：第一遍 15 轮一首不重复，之后的重播间隔都超过十首。
  expect(metrics).toMatchObject({
    unique: 15,
    firstRepeatRound: 16,
    repeats: 25,
    recentTenRepeats: 0,
  });
});

test("同名同歌手的不同歌曲编号独立统计感知重复", async () => {
  const { measureSongNames } = await import("../scripts/SongRandomnessProbe");
  const songs = [
    { id: "1", title: "同名曲目", artist: "歌手甲" },
    { id: "2", title: "同名曲目", artist: "歌手甲" },
    { id: "3", title: "同名曲目", artist: "歌手乙" },
  ];
  expect(measureSequence(["1", "2", "3"]).repeats).toBe(0);
  expect(measureSongNames(songs, ["1", "2", "3"])).toMatchObject({
    repeats: 1,
    adjacentRepeats: 1,
    unique: 2,
  });
  expect(() => measureSongNames(songs, ["4"])).toThrow("选歌序列包含歌单外曲目");
});
