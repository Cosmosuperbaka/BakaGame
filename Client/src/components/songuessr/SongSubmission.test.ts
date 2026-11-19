import { describe, expect, it, vi } from "vitest";
import type { SonGuessrCommandMap } from "@/lib/SonGuessrWs";
import type { GameSendCommand } from "@/lib/GameWs";
import { sendSongChoice, songPickFields } from "./SongSubmission";

const setup = () => {
  const send = vi.fn().mockResolvedValue({});
  return {
    send,
    call: (choice: Parameters<typeof sendSongChoice>[1]) =>
      sendSongChoice(send as unknown as GameSendCommand<SonGuessrCommandMap>, choice),
  };
};

describe("songPickFields", () => {
  it("只带有值的字段", () => {
    expect(songPickFields()).toEqual({});
    expect(songPickFields({ sources: [], requiresVip: undefined })).toEqual({});
    expect(songPickFields({ sources: ["a", "b"], requiresVip: false })).toEqual({
      sources: ["a", "b"],
      requiresVip: false,
    });
  });
});

describe("sendSongChoice", () => {
  const clip = { startTime: 1000, endTime: 5000 };

  it("听歌识曲出题：带片段、备用音源与会员标记，且不设请求超时", async () => {
    const { send, call } = setup();
    await call({
      questionType: "song",
      mode: "submit",
      id: "s1",
      clip,
      pick: { sources: ["s1", "qq:2"], requiresVip: true },
    });
    expect(send).toHaveBeenCalledWith(
      "song.game.submitSong",
      { songId: "s1", clip, sources: ["s1", "qq:2"], requiresVip: true },
      { timeout: 0 }
    );
  });

  it("听歌识曲出题：没有片段与备用音源时只发歌曲 id，会员标记为 false 也照带", async () => {
    const { send, call } = setup();
    await call({ questionType: "song", mode: "submit", id: "s1", pick: { requiresVip: false } });
    expect(send).toHaveBeenCalledWith(
      "song.game.submitSong",
      { songId: "s1", requiresVip: false },
      { timeout: 0 }
    );
  });

  it("听歌识曲猜测：只发歌曲 id，忽略片段与音源，用默认超时", async () => {
    const { send, call } = setup();
    await call({
      questionType: "song",
      mode: "guess",
      id: "s9",
      clip,
      pick: { sources: ["x"], requiresVip: true },
    });
    expect(send).toHaveBeenCalledWith("song.game.guess", { songId: "s9" }, undefined);
  });

  it("听歌识番出题：带番剧 id 与选中的关联曲，不设请求超时", async () => {
    const { send, call } = setup();
    await call({ questionType: "anime", mode: "submit", id: "sub1", extraId: "song-op" });
    expect(send).toHaveBeenCalledWith(
      "song.game.submitAnime",
      { subjectId: "sub1", songId: "song-op" },
      { timeout: 0 }
    );
  });

  it("听歌识番出题没有关联曲时不带 songId；猜番只发番剧 id", async () => {
    const { send, call } = setup();
    await call({ questionType: "anime", mode: "submit", id: "sub1" });
    expect(send).toHaveBeenLastCalledWith(
      "song.game.submitAnime",
      { subjectId: "sub1" },
      { timeout: 0 }
    );
    await call({ questionType: "anime", mode: "guess", id: "sub2", extraId: "ignored" });
    expect(send).toHaveBeenLastCalledWith("song.game.guessAnime", { subjectId: "sub2" }, undefined);
  });

  it("服务端拒绝时原样抛给调用方，由搜索框显示原因", async () => {
    const { send, call } = setup();
    send.mockRejectedValueOnce(new Error("不可播放"));
    await expect(call({ questionType: "song", mode: "guess", id: "s" })).rejects.toThrow(
      "不可播放"
    );
  });
});
