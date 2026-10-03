import {expect, test} from "bun:test";
import {expectedUnique, measureSequence} from "../scripts/SongRandomnessProbe";

test("选歌实测区分全局重复和最近十首重复", () => {
  expect(measureSequence(["a", "b", "a", "a"])).toMatchObject({
    rounds: 4, unique: 2, repeats: 2, repeatRate: 0.5, adjacentRepeats: 1,
    recentTenRepeats: 2, minimumGap: 1, firstRepeatRound: 3, maximumAppearances: 3,
  });
  expect(measureSequence([])).toMatchObject({repeatRate: 0, minimumGap: null, firstRepeatRound: null});
  const window = Array.from({length: 11}, (_, index) => String(index));
  expect(measureSequence([...window, "0"])).toMatchObject({repeats: 1, recentTenRepeats: 0, minimumGap: 11});
});

test("最近十首排除基线不使用有放回抽样的错误期望", () => {
  expect(expectedUnique(15, 10)).toBe(10);
  expect(expectedUnique(15, 11)).toBe(11);
  expect(expectedUnique(15, 12)).toBeCloseTo(11.8);
  expect(expectedUnique(15, 30)).toBeCloseTo(14.942353924769658);
  expect(expectedUnique(10, 30)).toBeNull();
});

test("实测驱动执行真实回合并保留最近十首防重行为", async () => {
  const {createProbeRoom} = await import("../scripts/SongRandomnessProbe");
  const songs = Array.from({length: 15}, (_, index) => ({
    id: String(index), title: `隔离曲目${index}`, artist: "测试歌手",
    audioUrl: "https://audio.example.test/fixture.mp3", lyrics: [], encyclopedia: {tags: []},
  }));
  const info = {id: "100001", name: "隔离歌单", songCount: songs.length};
  const room = await createProbeRoom({
    search: async () => [], getPlaylistSongs: async () => ({info, songs}),
    getSong: async id => songs.find(song => song.id === id)!,
    getSongMetadata: async id => songs.find(song => song.id === id)!,
    getLoginStatus: async cookie => ({cookie, account: {nickname: "夹具账号", vipStatus: "nonVip"}}),
  }, "MUSIC_U=fixture", info);
  const sequence: string[] = [];
  try { for (let index = 0; index < 40; index++) sequence.push(await room.next()); }
  finally { await room.close(); }
  const metrics = measureSequence(sequence);
  expect(metrics.rounds).toBe(40);
  expect(metrics.unique).toBeLessThanOrEqual(15);
  expect(metrics.repeats).toBeGreaterThanOrEqual(25);
  expect(metrics.recentTenRepeats).toBe(0);
});

test("同名同歌手的不同歌曲编号独立统计感知重复", async () => {
  const {measureSongNames} = await import("../scripts/SongRandomnessProbe");
  const songs = [{id: "1", title: "同名曲目", artist: "歌手甲"},
    {id: "2", title: "同名曲目", artist: "歌手甲"},
    {id: "3", title: "同名曲目", artist: "歌手乙"}];
  expect(measureSequence(["1", "2", "3"]).repeats).toBe(0);
  expect(measureSongNames(songs, ["1", "2", "3"])).toMatchObject({
    repeats: 1, adjacentRepeats: 1, unique: 2,
  });
  expect(() => measureSongNames(songs, ["4"])).toThrow("选歌序列包含歌单外曲目");
});
