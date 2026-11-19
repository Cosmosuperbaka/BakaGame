import { Value } from "@sinclair/typebox/value";
import { SonGuessrPayloadSchemas } from "../../src/shared/SonGuessr";
import { fakeBangumiProvider } from "../support/Providers";
import { describe, expect, test } from "bun:test";
import {
  anime,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  provider,
  songs,
  startRound,
  wrongAnime,
  type TestConnection,
} from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import type { SonGuessrPrivateState, SonGuessrRoomSnapshot } from "../../src/shared/Index";

// 旁观身份零门槛可得（另开标签页以新名字入房即可），所以「允许旁观」不能蕴含「旁观能看到答案」：
// 局中旁观者的私有态与全部下行帧里都不能出现答案，揭晓之后才公开；房主打开开关则保持观战体验。

/** 序列化后能直接搜到的答案线索：曲名与图片地址里的歌曲标识。 */
const SONG_CLUES = [songs.answer.title, "img/answer.jpg"];
const ANIME_CLUES = [anime.nameCn!, anime.imageUrl!];

const frameText = (client: TestConnection, from = 0): string =>
  JSON.stringify(client.sent.slice(from));

const stateOf = (client: TestConnection) =>
  lastEvent<SonGuessrPrivateState>(client, "song.game.privateState");
const snapshotOf = (client: TestConnection) =>
  lastEvent<SonGuessrRoomSnapshot>(client, "song.room.snapshot");

const setSettings = (
  service: SonGuessrService,
  host: TestConnection,
  payload: Record<string, unknown>
) =>
  execute(service, host, {
    id: `settings-${Object.keys(payload).join("-")}`,
    type: "song.room.updateSettings",
    roomId: "1234",
    payload,
  } as never);

interface Scene {
  service: SonGuessrService;
  host: TestConnection;
  guest: TestConnection;
  /** 局中才进房：服务端把非等待阶段加入者记为旁观者。 */
  lateSpectator: TestConnection;
  /** 开局前主动切成旁观者。 */
  earlySpectator: TestConnection;
  /** 局中把自己切成旁观者的正式玩家：只是预约下一轮，本轮仍是玩家。 */
  switcher: TestConnection;
}

const startPlaying = async (settings: Record<string, unknown> = {}): Promise<Scene> => {
  const service = new SonGuessrService({ musicProvider: provider });
  const host = connection(service, "sa-host");
  const guest = connection(service, "sa-guest");
  const earlySpectator = connection(service, "sa-early");
  const switcher = connection(service, "sa-switcher");
  await createRoom(service, host);
  const hostState = stateOf(host);
  await joinRoom(service, guest, "猜歌玩家");
  await joinRoom(service, earlySpectator, "早到旁观");
  await joinRoom(service, switcher, "中途换座");
  await execute(service, earlySpectator, {
    id: "early-spectate",
    type: "song.player.setSpectator",
    roomId: "1234",
    payload: { spectator: true },
  });
  await execute(service, switcher, {
    id: "switcher-ready",
    type: "song.player.setReady",
    roomId: "1234",
    payload: { ready: true },
  });
  if (Object.keys(settings).length > 0) await setSettings(service, host, settings);
  await startRound(service, host, guest, hostState.playerId);
  const lateSpectator = connection(service, "sa-late");
  await joinRoom(service, lateSpectator, "迟到旁观");
  await execute(service, switcher, {
    id: "switcher-spectate",
    type: "song.player.setSpectator",
    roomId: "1234",
    payload: { spectator: true },
  });
  return { service, host, guest, lateSpectator, earlySpectator, switcher };
};

describe("猜歌旁观者的答案可见性", () => {
  test("缺省关闭：局中旁观者的私有态与全部下行帧里搜不到答案", async () => {
    const scene = await startPlaying();
    expect(snapshotOf(scene.host).phase).toBe("playing");

    for (const spectator of [scene.lateSpectator, scene.earlySpectator]) {
      expect(snapshotOf(spectator).players.find((p) => p.isHost)).toBeDefined();
      const state = stateOf(spectator);
      expect(state.submittedSong).toBeUndefined();
      expect(state.submittedAnime).toBeUndefined();
      expect(state.visibleAttempts).toEqual([]);
      const text = frameText(spectator);
      for (const clue of SONG_CLUES) expect(text).not.toContain(clue);
    }
    // 出题人照常看得到自己出的题。
    expect(stateOf(scene.host).submittedSong?.id).toBe(songs.answer.id);
  });

  test("局中预约旁观的正式玩家本轮仍是玩家，同样拿不到答案", async () => {
    const scene = await startPlaying();
    const state = stateOf(scene.switcher);
    expect(snapshotOf(scene.switcher).players.find((p) => p.name === "中途换座")?.membership).toBe(
      "active"
    );
    expect(state.submittedSong).toBeUndefined();
    for (const clue of SONG_CLUES) expect(frameText(scene.switcher)).not.toContain(clue);
  });

  test("缺省关闭：他人的猜测记录也不外泄，揭晓后旁观者拿得到答案", async () => {
    const scene = await startPlaying();
    await execute(scene.service, scene.guest, {
      id: "audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    await execute(scene.service, scene.guest, {
      id: "wrong-guess",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "wrong" },
    });
    expect(stateOf(scene.lateSpectator).visibleAttempts).toEqual([]);
    expect(stateOf(scene.guest).visibleAttempts).toHaveLength(1);

    const beforeResult = scene.lateSpectator.sent.length;
    await execute(scene.service, scene.guest, {
      id: "right-guess",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(snapshotOf(scene.host).phase).not.toBe("playing");
    expect(stateOf(scene.lateSpectator).submittedSong?.id).toBe(songs.answer.id);
    expect(frameText(scene.lateSpectator, beforeResult)).toContain(songs.answer.title);
    expect(stateOf(scene.lateSpectator).visibleAttempts.length).toBeGreaterThan(1);
  });

  test("开关打开：局中旁观者照常看得到答案与全部猜测", async () => {
    const scene = await startPlaying({ spectatorsSeeAnswers: true });
    expect(snapshotOf(scene.host).settings.spectatorsSeeAnswers).toBe(true);
    for (const spectator of [scene.lateSpectator, scene.earlySpectator]) {
      expect(stateOf(spectator).submittedSong?.id).toBe(songs.answer.id);
      expect(frameText(spectator)).toContain(songs.answer.title);
    }
    // 开关只管旁观者：局中的普通玩家依旧不见答案。
    expect(stateOf(scene.guest).submittedSong).toBeUndefined();
    expect(stateOf(scene.switcher).submittedSong).toBeUndefined();
  });

  test("设置随公开快照下发；旧房间没有这个字段时按关闭处理", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "sa-settings");
    await createRoom(service, host);
    expect(snapshotOf(host).settings.spectatorsSeeAnswers ?? false).toBe(false);
    await setSettings(service, host, { spectatorsSeeAnswers: true });
    expect(snapshotOf(host).settings.spectatorsSeeAnswers).toBe(true);
    // 旧快照里没有这个字段：直接删掉模拟，视图判定按关闭处理。
    delete (service.rooms.get("1234")!.settings as { spectatorsSeeAnswers?: boolean })
      .spectatorsSeeAnswers;
    const late = connection(service, "sa-settings-late");
    await joinRoom(service, late, "路人");
    expect(snapshotOf(late).settings.spectatorsSeeAnswers ?? false).toBe(false);
  });

  test("旧房间的设置里没有这个字段：局中进房的旁观者照样拿不到答案", async () => {
    const scene = await startPlaying();
    // 旧快照恢复出来的房间没有这个字段：直接删掉模拟，再让一名旁观者局中进房，看视图怎么判。
    delete (scene.service.rooms.get("1234")!.settings as { spectatorsSeeAnswers?: boolean })
      .spectatorsSeeAnswers;
    const late = connection(scene.service, "sa-legacy-late");
    await joinRoom(scene.service, late, "老房旁观");
    expect(stateOf(late).submittedSong).toBeUndefined();
    expect(stateOf(late).visibleAttempts).toEqual([]);
    for (const clue of SONG_CLUES) expect(frameText(late)).not.toContain(clue);
  });

  test("听歌猜番：旁观者局中同样拿不到番剧答案，打开开关后可见", async () => {
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async (subjectId: string) => (subjectId === anime.id ? anime : wrongAnime),
      searchSubjects: async () => [anime],
    });
    const run = async (open: boolean) => {
      const service = new SonGuessrService({ musicProvider: provider, bangumiProvider });
      const host = connection(service, `anime-host-${open}`);
      const guest = connection(service, `anime-guest-${open}`);
      await createRoom(service, host);
      const hostState = stateOf(host);
      await joinRoom(service, guest, "猜番玩家");
      await setSettings(service, host, { questionType: "anime", spectatorsSeeAnswers: open });
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
      const spectator = connection(service, `anime-spec-${open}`);
      await joinRoom(service, spectator, "旁观者");
      return { spectator, host };
    };
    const closed = await run(false);
    expect(stateOf(closed.spectator).submittedAnime).toBeUndefined();
    for (const clue of ANIME_CLUES) expect(frameText(closed.spectator)).not.toContain(clue);
    expect(stateOf(closed.host).submittedAnime?.id).toBe(anime.id);

    const opened = await run(true);
    expect(stateOf(opened.spectator).submittedAnime?.id).toBe(anime.id);
  });

  test("设置消息的契约只接受布尔值", () => {
    const schema = SonGuessrPayloadSchemas["song.room.updateSettings"];
    expect(Value.Check(schema, { spectatorsSeeAnswers: true })).toBe(true);
    expect(Value.Check(schema, { spectatorsSeeAnswers: "yes" })).toBe(false);
  });

  test("Agent 以旁观身份在房时走同一份视图：局中同样拿不到答案", async () => {
    const scene = await startPlaying({ allowAgents: true });
    const agent = connection(scene.service, "sa-agent");
    agent.record.isAgent = true;
    await joinRoom(scene.service, agent, "旁观Agent");
    expect(snapshotOf(agent).players.find((p) => p.name === "旁观Agent")?.membership).toBe(
      "spectator"
    );
    expect(stateOf(agent).submittedSong).toBeUndefined();
    for (const clue of SONG_CLUES) expect(frameText(agent)).not.toContain(clue);
  });
});
