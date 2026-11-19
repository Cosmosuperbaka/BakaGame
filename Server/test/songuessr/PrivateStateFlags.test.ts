import { describe, expect, test } from "bun:test";
import { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import type { SonGuessrPrivateState, SonGuessrRoomSnapshot } from "../../src/shared/Index";
import { deferred } from "../support/Deferred";
import {
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  provider,
  songs,
  startRound,
  type TestConnection,
} from "./Fixtures";

// canGuess / canGiveUp / remainingGuesses 直接决定界面按钮的亮灭与次数显示：
// 这里只断言玩家收到的 song.game.privateState，不读实现内部的中间状态。

const privateOf = (client: TestConnection) =>
  lastEvent<SonGuessrPrivateState>(client, "song.game.privateState");
const snapshotOf = (client: TestConnection) =>
  lastEvent<SonGuessrRoomSnapshot>(client, "song.room.snapshot");

const ready = (service: SonGuessrService, client: TestConnection) =>
  execute(service, client, {
    id: `ready-${client.record.id}`,
    type: "song.player.setReady",
    roomId: "1234",
    payload: { ready: true },
  });

const audio = (service: SonGuessrService, client: TestConnection) =>
  execute(service, client, {
    id: `audio-${client.record.id}`,
    type: "song.game.audioReady",
    roomId: "1234",
    payload: { roundNumber: 1 },
  });

const guess = (service: SonGuessrService, client: TestConnection, songId: string) =>
  execute(service, client, {
    id: `guess-${client.record.id}-${songId}`,
    type: "song.game.guess",
    roomId: "1234",
    payload: { songId },
  });

const giveUp = (service: SonGuessrService, client: TestConnection) =>
  execute(service, client, {
    id: `give-up-${client.record.id}`,
    type: "song.game.giveUp",
    roomId: "1234",
    payload: {},
  });

const setTeam = (service: SonGuessrService, client: TestConnection, team: number) =>
  execute(service, client, {
    id: `team-${client.record.id}-${team}`,
    type: "song.player.setTeam",
    roomId: "1234",
    payload: { team },
  });

/** 房主出题、两名猜歌玩家；返回时回合刚开始，两人的音频都未就绪。 */
const setup = async (
  settings: Record<string, unknown> = {},
  musicProvider: MusicProvider = provider
) => {
  const service = new SonGuessrService({ musicProvider, random: { nextInt: () => 0 } });
  const host = connection(service, "flags-host");
  const first = connection(service, "flags-first");
  const second = connection(service, "flags-second");
  await createRoom(service, host);
  const hostId = privateOf(host).playerId;
  await joinRoom(service, first, "玩家一");
  await joinRoom(service, second, "玩家二");
  if (Object.keys(settings).length > 0) {
    await execute(service, host, {
      id: "flags-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: settings,
    });
  }
  await ready(service, second);
  await startRound(service, host, first, hostId);
  return { service, host, first, second };
};

describe("猜歌私有态的作答标志", () => {
  test("回合开始未就绪音频时能放弃不能猜，就绪后能猜", async () => {
    const { service, first } = await setup();
    const before = privateOf(first);
    expect(before.canGuess).toBe(false);
    expect(before.canGiveUp).toBe(true);
    expect(before.remainingGuesses).toBe(3);

    await audio(service, first);
    const after = privateOf(first);
    expect(after.canGuess).toBe(true);
    expect(after.canGiveUp).toBe(true);
    expect(after.remainingGuesses).toBe(3);
  });

  test("血战到底里猜中后本人收起能猜与能放弃，他人照常作答", async () => {
    const { service, first, second } = await setup({ bloodMode: true });
    await audio(service, first);
    await audio(service, second);
    await guess(service, first, "answer");
    expect(snapshotOf(first).phase).toBe("playing");

    const winner = privateOf(first);
    expect(winner.canGuess).toBe(false);
    expect(winner.canGiveUp).toBe(false);
    expect(winner.remainingGuesses).toBe(2);
    const other = privateOf(second);
    expect(other.canGuess).toBe(true);
    expect(other.canGiveUp).toBe(true);
    expect(other.remainingGuesses).toBe(3);
  });

  test("放弃后本人收起能猜与能放弃且剩余次数不变，他人照常作答", async () => {
    const { service, first, second } = await setup();
    await audio(service, first);
    await audio(service, second);
    await giveUp(service, first);
    expect(snapshotOf(first).phase).toBe("playing");

    const quit = privateOf(first);
    expect(quit.canGuess).toBe(false);
    expect(quit.canGiveUp).toBe(false);
    expect(quit.remainingGuesses).toBe(3);
    const other = privateOf(second);
    expect(other.canGuess).toBe(true);
    expect(other.canGiveUp).toBe(true);
  });

  test("次数用尽后本人收起能猜与能放弃且剩余次数归零", async () => {
    const { service, first, second } = await setup({ maxGuessesPerRound: 1 });
    await audio(service, first);
    await audio(service, second);
    await guess(service, first, "wrong");
    expect(snapshotOf(first).phase).toBe("playing");

    const spent = privateOf(first);
    expect(spent.canGuess).toBe(false);
    expect(spent.canGiveUp).toBe(false);
    expect(spent.remainingGuesses).toBe(0);
    const other = privateOf(second);
    expect(other.canGuess).toBe(true);
    expect(other.canGiveUp).toBe(true);
    expect(other.remainingGuesses).toBe(1);
  });

  test("回合揭晓后没答完的玩家收起能猜与能放弃", async () => {
    const { service, first, second } = await setup();
    await audio(service, first);
    await audio(service, second);
    await guess(service, first, "answer");
    expect(snapshotOf(first).phase).toBe("roundResult");

    const idle = privateOf(second);
    expect(idle.canGuess).toBe(false);
    expect(idle.canGiveUp).toBe(false);
    expect(idle.remainingGuesses).toBe(3);
    const winner = privateOf(first);
    expect(winner.canGuess).toBe(false);
    expect(winner.canGiveUp).toBe(false);
  });

  test("猜测在途时暂时收起能放弃，校验完成后恢复", async () => {
    const gate = deferred();
    const slowProvider: MusicProvider = {
      ...provider,
      getSongMetadata: async (id) => {
        await gate.promise;
        return songs[id as keyof typeof songs];
      },
    };
    const { service, first, second } = await setup({}, slowProvider);
    await audio(service, first);
    await audio(service, second);
    const pending = guess(service, first, "wrong");
    // 在途期间没有针对本人的发布：借另一名玩家的放弃触发全房扇出，拿到在途时的私有态。
    await giveUp(service, second);

    const inFlight = privateOf(first);
    expect(inFlight.canGuess).toBe(true);
    expect(inFlight.canGiveUp).toBe(false);
    expect(inFlight.remainingGuesses).toBe(2);

    gate.resolve();
    await pending;
    const settled = privateOf(first);
    expect(settled.canGuess).toBe(true);
    expect(settled.canGiveUp).toBe(true);
    expect(settled.remainingGuesses).toBe(2);
  });

  test("出题人、出题队友与旁观者的私有态不给能猜与能放弃", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "flags-team-host");
    const teammate = connection(service, "flags-teammate");
    const guesser = connection(service, "flags-guesser");
    await createRoom(service, host);
    const hostId = privateOf(host).playerId;
    await joinRoom(service, teammate, "队友");
    await joinRoom(service, guesser, "猜歌玩家");
    await setTeam(service, host, 1);
    await setTeam(service, teammate, 1);
    await ready(service, teammate);
    await ready(service, guesser);
    await startRound(service, host, guesser, hostId);
    const spectator = connection(service, "flags-spectator");
    await joinRoom(service, spectator, "旁观者");

    const submitter = privateOf(host);
    expect(submitter.canGuess).toBe(false);
    expect(submitter.canGiveUp).toBe(false);
    const observer = privateOf(teammate);
    expect(observer.teamObserver).toBe(true);
    expect(observer.canGuess).toBe(false);
    expect(observer.canGiveUp).toBe(false);
    const watching = privateOf(spectator);
    expect(watching.canGuess).toBe(false);
    expect(watching.canGiveUp).toBe(false);

    // 对照：同一回合里普通猜歌玩家就绪音频后能猜。
    await audio(service, guesser);
    expect(privateOf(guesser).canGuess).toBe(true);
  });
});
