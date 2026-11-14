import { describe, expect, test } from "bun:test";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import { BangumiDataProvider } from "../../src/infrastructure/BangumiDataProvider";
import { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { SonGuessrPrivateState, SonGuessrRoomSnapshot } from "../../src/shared/Index";
import {
  anime,
  chosenSongId,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  provider,
  songs,
  wrongAnime,
} from "./Fixtures";

describe("SonGuessrService", () => {
  test("听歌猜番提交后只向出题人公开答案，并按 subject ID 完成猜测结算", async () => {
    const bangumiProvider = {
      getSubject: async (subjectId: string) => (subjectId === anime.id ? anime : wrongAnime),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const service = new SonGuessrService({ musicProvider: provider, bangumiProvider });
    const host = connection(service, "anime-host");
    const guest = connection(service, "anime-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "猜番玩家");
    await execute(service, host, {
      id: "anime-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionType: "anime" },
    });
    await execute(service, guest, {
      id: "anime-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "anime-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "anime-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "anime-submit",
      type: "song.game.submitAnime",
      roomId: "1234",
      payload: { subjectId: anime.id },
    });

    expect(
      lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").submittedAnime?.id
    ).toBe(anime.id);
    expect(
      lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").submittedAnime
    ).toBeUndefined();
    await execute(service, guest, {
      id: "anime-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    await expect(
      execute(service, guest, {
        id: "anime-wrong-guess",
        type: "song.game.guessAnime",
        roomId: "1234",
        payload: { subjectId: wrongAnime.id },
      })
    ).resolves.toMatchObject({ attempt: { result: "wrong", guessedAnime: { id: wrongAnime.id } } });
    await execute(service, guest, {
      id: "anime-correct-guess",
      type: "song.game.guessAnime",
      roomId: "1234",
      payload: { subjectId: anime.id },
    });
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(snapshot.phase).toBe("roundResult");
    // 本轮作答结果：猜中的人拿到一枚 correct；出题人不作答，因此不带结果。
    const marked = snapshot.players.filter((p) => p.roundMarks.length > 0);
    expect(marked.map((p) => p.roundMarks)).toEqual([["correct"]]);
    expect(
      snapshot.players.find((p) => p.id === snapshot.roundSummary?.submitterPlayerId)?.roundMarks
    ).toEqual([]);
    expect(snapshot.roundSummary?.anime?.id).toBe(anime.id);
    expect(snapshot.roundSummary?.animeTrack).toEqual({
      title: "答案歌",
      artist: "测试歌手",
      kind: "opening",
    });
    expect(snapshot.roundSummary?.song.title).toBe("答案歌");
    expect(snapshot.roundSummary?.attempts.map((attempt) => attempt.guessedAnime?.id)).toEqual([
      wrongAnime.id,
      anime.id,
    ]);
  });

  test("听歌猜番回合拒绝用猜歌命令作答，也不占用猜测次数", async () => {
    const bangumiProvider = {
      getSubject: async (subjectId: string) => (subjectId === anime.id ? anime : wrongAnime),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const service = new SonGuessrService({ musicProvider: provider, bangumiProvider });
    const host = connection(service, "anime-gate-host");
    const guest = connection(service, "anime-gate-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "猜番玩家");
    const send = (id: string, type: string, payload: unknown, client = host) =>
      execute(service, client, { id, type, roomId: "1234", payload } as never);
    await send("gate-settings", "song.room.updateSettings", { questionType: "anime" });
    await send("gate-ready", "song.player.setReady", { ready: true }, guest);
    await send("gate-start", "song.game.start", {});
    await send("gate-choose", "song.game.chooseSubmitter", { playerId: hostState.playerId });
    await send("gate-submit", "song.game.submitAnime", { subjectId: anime.id });
    await send("gate-audio", "song.game.audioReady", { roundNumber: 1 }, guest);

    // 出题歌曲就是答案：若猜歌命令能判对，整个猜番回合就被绕过了。
    await expect(
      send("gate-song-guess", "song.game.guess", { songId: "answer" }, guest)
    ).rejects.toMatchObject({ code: "INVALID_QUESTION_TYPE" });
    expect(lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").phase).toBe("playing");
    await expect(
      send("gate-anime-guess", "song.game.guessAnime", { subjectId: wrongAnime.id }, guest)
    ).resolves.toMatchObject({ attempt: { guessNumber: 1, result: "wrong" } });
  });

  test("听歌猜番拒绝歌名与曲目不匹配的异形歌曲", async () => {
    const unrelated = { ...songs.wrong, id: "unrelated", title: "TAKE ME HIGHER" };
    const matched = { ...songs.answer, id: "matched", title: "答案歌" };
    const bangumiProvider = {
      searchSubjects: async () => [anime],
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "测试歌手", kind: "opening" }],
      }),
    } as unknown as BangumiDataProvider;

    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [unrelated, matched], // 异形歌排第一，匹配歌排第二
      getSong: async (id) => (id === "unrelated" ? unrelated : matched),
    };

    const service = new SonGuessrService({ musicProvider, bangumiProvider });
    const host = connection(service, "anime-mismatch-host");
    const guest = connection(service, "anime-mismatch-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "猜番玩家");
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
    await execute(service, host, {
      id: "start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });

    // 必须跳过排在第一的 TAKE ME HIGHER，精准选出匹配的答案歌
    expect(chosenSongId(service, "1234")).toBe(matched.id);
  });

  test("自动猜番多轮之间优先避开最近出过的番剧与歌曲", async () => {
    const anime1 = { ...anime, id: "anime-1", name: "番剧一" };
    const anime2 = { ...anime, id: "anime-2", name: "番剧二" };
    const song1 = { ...songs.answer, id: "song-1", title: "歌曲一" };
    const song2 = { ...songs.answer, id: "song-2", title: "歌曲二" };

    const bangumiProvider = {
      searchSubjects: async () => [anime1, anime2],
      getSubject: async (id: string) =>
        id === "anime-1"
          ? { ...anime1, musicTracks: [{ title: "歌曲一", kind: "opening" }] }
          : { ...anime2, musicTracks: [{ title: "歌曲二", kind: "opening" }] },
    } as unknown as BangumiDataProvider;

    const musicProvider: MusicProvider = {
      ...provider,
      search: async (query) => (query.includes("歌曲一") ? [song1] : [song2]),
      getSong: async (id) => (id === "song-1" ? song1 : song2),
    };

    const service = new SonGuessrService({
      musicProvider,
      bangumiProvider,
      random: { nextInt: () => 0 }, // 永远尝试第0个
    });

    const host = connection(service, "anime-dedup-host");
    const guest = connection(service, "anime-dedup-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "防重玩家");
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

    // 第 1 轮开始
    await execute(service, host, {
      id: "start-1",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    expect(chosenSongId(service, "1234")).toBe(song1.id);

    // 音频就绪并猜对：关掉血战时一名玩家猜对即结束第 1 轮，无需再有人投降
    await execute(service, guest, {
      id: "audio-1",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    await execute(service, guest, {
      id: "guess-1",
      type: "song.game.guessAnime",
      roomId: "1234",
      payload: { subjectId: "anime-1" },
    });
    const summary1 = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").roundSummary;
    expect(summary1?.anime?.id).toBe("anime-1");
    expect(summary1?.song.id).toBe("song-1");

    // 开始第 2 轮
    await execute(service, host, {
      id: "next-2",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });

    // 第 2 轮必须优先避让 anime-1，选择 anime-2 和 song-2
    expect(chosenSongId(service, "1234")).toBe(song2.id);

    await execute(service, guest, {
      id: "audio-2",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 2 },
    });
    await execute(service, guest, {
      id: "guess-2",
      type: "song.game.guessAnime",
      roomId: "1234",
      payload: { subjectId: "anime-2" },
    });
    const summary2 = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").roundSummary;
    expect(summary2?.anime?.id).toBe("anime-2");
    expect(summary2?.song.id).toBe("song-2");
  });
});
